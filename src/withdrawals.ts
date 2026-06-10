import { finalizeWithdrawalMutation, submitWithdrawalMutation } from "@zeko-labs/graphql"
import {
	AccountUpdate,
	AccountUpdateForest,
	Bool,
	Field,
	Mina,
	Provable,
	PublicKey,
	Signature,
	TokenId,
	UInt32,
	UInt64
} from "o1js"
import { Actions, Events, fromList } from "./actions"
import {
	assertFirstWithdrawalAmountCanCreateHelper,
	ensureFirstWithdrawalAmountCanCreateHelper,
	InsufficientFirstWithdrawalAmountError
} from "./errors"
import { fetchAccount, fetchCurrentSlot, setL1, setL2 } from "./network"
import { pollProvingResult } from "./prover"
import { debug, type BridgeRuntime } from "./runtime"
import {
	normalizeRetryableTransactionOptions,
	type RetryableTransactionOptions,
	type SignTransaction
} from "./transactions"
import type {
	Account,
	Action,
	ExtractInput,
	InnerWitness,
	Withdrawal,
	WithdrawalFinalizationResult,
	WithdrawalWithState,
	WitnessFetchResult
} from "./types"
import {
	bridgeVersionForActionIndex,
	fetchActions,
	fetchCommitAsePastSlot,
	fetchInnerActionsFromIndexer,
	fetchInnerWitnessesFromAuxes,
	fetchRecentActions,
	filterNulls,
	getNextWithdrawalIndex,
	getVkHash,
	refreshCache,
	safeDecrement,
	uint32Max,
	withdrawalAux
} from "./utils"

const NO_OUTER_COMMIT_REASON = "No outer commit available yet"
const SKIPPED_LEGACY_WITHDRAWAL_ACTION_INDEX = 3

const isSkippedLegacyWithdrawalAction = (runtime: BridgeRuntime, actionIndex: number): boolean =>
	runtime.config.l2Network === "testnet" && actionIndex === SKIPPED_LEGACY_WITHDRAWAL_ACTION_INDEX

const isUnknownLiveActionCursorError = (error: unknown): boolean => {
	const message =
		error && typeof error === "object" && "message" in error ? String(error.message) : String(error)
	return /\bfrom\s+\d+\s+not found\b/i.test(message)
}

const mergeActionsByAfterState = <TAction extends Action>(actions: TAction[]): TAction[] => {
	const seen = new Set<string>()
	return actions.filter((action) => {
		const afterState = action.afterActionState.toString()
		if (seen.has(afterState)) return false
		seen.add(afterState)
		return true
	})
}

async function fetchLiveWithdrawalActions(
	runtime: BridgeRuntime,
	pk: PublicKey,
	lastArchiveActionState?: string
): Promise<Action[]> {
	if (!lastArchiveActionState) return await fetchRecentActions(runtime.l2Client, pk)

	try {
		return await fetchRecentActions(runtime.l2Client, pk, lastArchiveActionState)
	} catch (error) {
		if (!isUnknownLiveActionCursorError(error)) throw error

		debug(runtime, "fetchUserWithdrawals live cursor not found; retrying without cursor", {
			lastArchiveActionState
		})
		return await fetchRecentActions(runtime.l2Client, pk)
	}
}

export async function fetchUserWithdrawalActions(
	runtime: BridgeRuntime,
	pk: PublicKey
): Promise<Array<Action & Withdrawal>> {
	const archiveActions = await fetchActions(runtime.l2ArchiveClient, pk)
	const lastActionState = archiveActions.at(-1)?.afterActionState.toString()
	const liveActions = await fetchLiveWithdrawalActions(runtime, pk, lastActionState)
	const userInnerActions = mergeActionsByAfterState([...archiveActions, ...liveActions])

	debug(runtime, "fetchUserWithdrawals action sources", {
		archiveEndpoint: runtime.config.zekoArchiveUrl,
		liveEndpoint: runtime.config.zekoUrl,
		archiveCount: archiveActions.length,
		liveCount: liveActions.length,
		totalCount: userInnerActions.length,
		lastArchivedActionState: lastActionState
	})

	return filterNulls(
		userInnerActions.map((item) => {
			const [recipient1, recipient2, amount1] = item.action

			if (!recipient1 || !recipient2 || !amount1) return null

			return {
				...item,
				recipient: PublicKey.fromFields([recipient1, recipient2]),
				amount: UInt64.fromFields([amount1])
			}
		})
	)
}

export async function fetchUserWithdrawals(
	runtime: BridgeRuntime,
	pk: PublicKey
): Promise<Withdrawal[]> {
	return (await fetchUserWithdrawalActions(runtime, pk)).map(({ recipient, amount }) => ({
		recipient,
		amount
	}))
}

function minimumFirstWithdrawalAmount(runtime: BridgeRuntime): UInt64 {
	return runtime.l1AccountCreationFee.add(runtime.bridgeProofFee)
}

export async function submitWithdrawal(
	runtime: BridgeRuntime,
	feePayer: Mina.FeePayerSpec,
	{
		recipient,
		amount
	}: {
		recipient: PublicKey
		amount: UInt64
	},
	signTxn: SignTransaction
): Promise<string> {
	setL2(runtime)

	await ensureFirstWithdrawalAmountCanCreateHelper({
		amount,
		recipient,
		accountCreationFee: minimumFirstWithdrawalAmount(runtime),
		helperAccountExists: async () =>
			(await fetchAccount(runtime.l1Client, recipient, TokenId.derive(runtime.outerTokenOwner))) !==
			null
	})

	await refreshCache(recipient)
	await refreshCache(feePayer)
	await refreshCache(runtime.innerHolder)
	await refreshCache(runtime.innerPk)
	await refreshCache(runtime.bridgeFeeRecipientL2)

	const txn = await Mina.transaction(feePayer, async () => {
		const transferrer = AccountUpdate.createSigned(recipient)
		transferrer.balance.subInPlace(amount.add(runtime.bridgeProofFee))
		transferrer.body.actions = Actions.pushAction(transferrer.body.actions, [
			...recipient.toFields(),
			...amount.toFields()
		])
		transferrer.body.incrementNonce = Bool(true)
		transferrer.account.nonce.getAndRequireEquals()
		transferrer.body.useFullCommitment = Bool(false)

		const receiver = AccountUpdate.create(runtime.innerHolder)
		receiver.balance.addInPlace(amount)
		receiver.body.useFullCommitment = Bool(true)
		receiver.body.implicitAccountCreationFee = Bool(true)
		receiver.body.mayUseToken = {
			parentsOwnToken: Bool(true),
			inheritFromParent: Bool(false)
		}
		receiver.body.authorizationKind = {
			isSigned: Bool(false),
			isProved: Bool(true),
			verificationKeyHash: await getVkHash(runtime.innerHolder)
		}

		const feePayout = AccountUpdate.create(runtime.bridgeFeeRecipientL2)
		feePayout.balance.addInPlace(runtime.bridgeProofFee)
		feePayout.body.useFullCommitment = Bool(true)
		feePayout.body.implicitAccountCreationFee = Bool(true)
		feePayout.body.mayUseToken = {
			parentsOwnToken: Bool(true),
			inheritFromParent: Bool(false)
		}

		const childrenHash = AccountUpdateForest.fromFlatArray([receiver, feePayout]).hash

		const actionWitness = AccountUpdate.create(runtime.innerPk)
		actionWitness.approve(receiver)
		actionWitness.approve(feePayout)
		actionWitness.body.actions = Actions.pushAction(actionWitness.body.actions, [
			Field(0), // tag
			withdrawalAux({
				recipient,
				amount
			}), // aux
			childrenHash // children hash
		])
		actionWitness.body.useFullCommitment = Bool(true)
		actionWitness.body.implicitAccountCreationFee = Bool(true)
		actionWitness.body.mayUseToken = {
			parentsOwnToken: Bool(false),
			inheritFromParent: Bool(false)
		}
		actionWitness.body.authorizationKind = {
			isSigned: Bool(false),
			isProved: Bool(true),
			verificationKeyHash: await getVkHash(runtime.innerPk)
		}

		AccountUpdate.attachToTransaction(actionWitness)
	})

	const signed = await signTxn(txn)
	const transferrer = signed.transaction.accountUpdates.find(({ publicKey }) =>
		publicKey.equals(recipient).toBoolean()
	)
	if (!transferrer) throw new Error("Transferrer not found")

	const { data } = await runtime.l2Client().mutation(submitWithdrawalMutation, {
		withdrawalParams: {
			recipient: recipient.toBase58(),
			amount: amount.toString(),
			children: "[]"
		},
		transferrer: JSON.stringify([AccountUpdate.toJSON(transferrer)])
	})
	if (!data?.request?.key) throw new Error("No key returned from mutation")

	return await pollProvingResult(runtime, data.request.key)
}

export async function fetchWithdrawalFinalizationWitnesses(
	runtime: BridgeRuntime,
	pk: PublicKey,
	outerHolder: PublicKey
): Promise<
	WitnessFetchResult<{
		commitAseTarget: Field
		commitSlotRange: {
			lower: UInt32
			upper: UInt32
		}
		withdrawalParams: {
			withdrawal: Withdrawal
			aux: Field
		}
		helperAccount: Account | null
		witness: ExtractInput<typeof finalizeWithdrawalMutation>
	}>
> {
	const helperAccount = await (runtime.bridge?.fetchAccount ?? fetchAccount)(
		runtime.l1Client,
		pk,
		TokenId.derive(runtime.outerTokenOwner)
	)
	debug(runtime, "fetchWithdrawalFinalizationWitnesses helperAccount", {
		pk: pk.toBase58(),
		hasHelperAccount: helperAccount !== null
	})

	const prevNextWithdrawal = helperAccount ? getNextWithdrawalIndex(helperAccount) : UInt32.zero
	debug(runtime, "fetchWithdrawalFinalizationWitnesses prevNextWithdrawal", {
		prevNextWithdrawal: prevNextWithdrawal.toString()
	})

	const withdrawals = (
		await (runtime.bridge?.fetchUserWithdrawals?.(pk) ?? fetchUserWithdrawals(runtime, pk))
	).map((withdrawal) => ({
		withdrawal,
		aux: withdrawalAux(withdrawal)
	}))
	debug(runtime, "fetchWithdrawalFinalizationWitnesses withdrawals", {
		count: withdrawals.length,
		recipients: withdrawals.map(({ withdrawal }) => withdrawal.recipient.toBase58()),
		amounts: withdrawals.map(({ withdrawal }) => withdrawal.amount.toString())
	})

	if (withdrawals.length === 0) {
		debug(runtime, "fetchWithdrawalFinalizationWitnesses no-withdrawals", {
			pk: pk.toBase58()
		})
		return { ok: false, msg: "No withdrawals found" }
	}

	const withdrawalWitnesses = await fetchInnerWitnessesFromAuxes(
		runtime.actionsApiClient,
		withdrawals.map(({ aux }) => aux.toString())
	)
	debug(runtime, "fetchWithdrawalFinalizationWitnesses witnessFetch", {
		requestedAuxes: withdrawals.length,
		witnessCount: withdrawalWitnesses.length,
		witnessIndices: withdrawalWitnesses.map((witness) => witness.index)
	})

	if (withdrawalWitnesses.length === 0) {
		debug(runtime, "fetchWithdrawalFinalizationWitnesses no-witnesses", {
			pk: pk.toBase58(),
			withdrawalCount: withdrawals.length
		})
		return { ok: false, msg: "No withdrawal witnesses found" }
	}

	const earliestBeforeState = withdrawalWitnesses
		.sort((a, b) => a.index - b.index)
		.at(0)?.beforeActionState
	debug(runtime, "fetchWithdrawalFinalizationWitnesses earliestBeforeState", {
		earliestBeforeState: earliestBeforeState?.toString() ?? null
	})

	if (earliestBeforeState === undefined) {
		return { ok: false, msg: "No earliest before state found" }
	}

	const currentSlot = await (runtime.bridge?.fetchCurrentSlot?.() ?? fetchCurrentSlot(runtime))
	debug(runtime, "fetchWithdrawalFinalizationWitnesses currentSlot", {
		currentSlot: currentSlot.toString(),
		withdrawalDelay: runtime.withdrawalDelay.toString(),
		targetSlot: currentSlot.sub(runtime.withdrawalDelay).toString()
	})

	const { commit: lastCommit, ase } = await fetchCommitAsePastSlot(
		runtime.actionsApiClient,
		+currentSlot.sub(runtime.withdrawalDelay)
	)
	if (lastCommit === null) {
		debug(runtime, "fetchWithdrawalFinalizationWitnesses no-outer-commit", {
			aseCount: ase.length
		})
		return { ok: false, msg: NO_OUTER_COMMIT_REASON, status: "waiting" }
	}
	debug(runtime, "fetchWithdrawalFinalizationWitnesses commitAsePastSlot", {
		aseCount: ase.length,
		innerActionState: lastCommit.innerActionState.toString(),
		innerActionStateLength: lastCommit.innerActionStateLength.toString(),
		afterActionState: lastCommit.afterActionState.toString()
	})

	const lastCommitAse = ase.map(({ action }) => fromList([action]).hash)
	const commitAseTarget = ase.at(-1)?.afterActionState ?? lastCommit.afterActionState

	const innerActions = await fetchInnerActionsFromIndexer(runtime.actionsApiClient, {
		fromState: earliestBeforeState.toString(),
		afterState: lastCommit.innerActionState.toString()
	})
	debug(runtime, "fetchWithdrawalFinalizationWitnesses innerActions", {
		count: innerActions.length,
		indices: innerActions.map((action) => action.index)
	})

	const findMatchingWithdrawal = (action: InnerWitness) =>
		withdrawals.find(({ aux }) => aux.equals(action.aux).toBoolean())

	const matchingWitnesses = withdrawalWitnesses.filter((witness) =>
		Boolean(findMatchingWithdrawal(witness))
	)
	const alreadyFinalisedWitnessIndices = matchingWitnesses
		.filter((witness) => prevNextWithdrawal.greaterThan(UInt32.from(witness.index)).toBoolean())
		.map((witness) => witness.index)
	const alreadyFinalisedWitnessCount = alreadyFinalisedWitnessIndices.length
	const unfinalisedWitnessCount = matchingWitnesses.length - alreadyFinalisedWitnessCount
	let insufficientFirstWithdrawalReason: string | null = null
	let alreadyFinalisedCount = 0
	let alreadyFinalisedIndex: number | undefined
	let unfinalisedMatchCount = 0

	const minWithdrawalIndex = uint32Max(runtime.V2_WITHDRAWALS_START_INDEX, prevNextWithdrawal)

	const myWithdrawalIndex = innerActions.findIndex((action) => {
		const matchingWithdrawal = findMatchingWithdrawal(action)

		if (!matchingWithdrawal) return false

		if (prevNextWithdrawal.greaterThan(UInt32.from(action.index)).toBoolean()) {
			alreadyFinalisedCount++
			alreadyFinalisedIndex = Math.max(alreadyFinalisedIndex ?? action.index, action.index)
			return false
		}

		if (minWithdrawalIndex.greaterThan(UInt32.from(action.index)).toBoolean()) return false

		unfinalisedMatchCount++

		// Preserve the historical protocol workaround for this testnet legacy withdrawal action.
		if (isSkippedLegacyWithdrawalAction(runtime, action.index)) return false

		try {
			assertFirstWithdrawalAmountCanCreateHelper({
				helperAccountExists: helperAccount !== null,
				amount: matchingWithdrawal.withdrawal.amount,
				recipient: matchingWithdrawal.withdrawal.recipient,
				accountCreationFee: minimumFirstWithdrawalAmount(runtime)
			})
		} catch (e) {
			if (e instanceof InsufficientFirstWithdrawalAmountError) {
				insufficientFirstWithdrawalReason ??= e.message
				return false
			}
			throw e
		}

		return true
	})
	debug(runtime, "fetchWithdrawalFinalizationWitnesses myWithdrawalIndex", {
		myWithdrawalIndex,
		prevNextWithdrawal: prevNextWithdrawal.toString()
	})

	if (myWithdrawalIndex === -1) {
		debug(runtime, "fetchWithdrawalFinalizationWitnesses no-my-withdrawal", {
			prevNextWithdrawal: prevNextWithdrawal.toString(),
			innerActionIndices: innerActions.map((action) => action.index)
		})
		if (insufficientFirstWithdrawalReason) {
			return { ok: false, msg: insufficientFirstWithdrawalReason, status: "blocked" }
		}
		if (
			(alreadyFinalisedCount > 0 && unfinalisedMatchCount === 0) ||
			(alreadyFinalisedWitnessCount > 0 && unfinalisedWitnessCount === 0)
		) {
			return {
				ok: false,
				msg: "Withdrawal already finalised",
				status: "alreadyFinalised",
				index: alreadyFinalisedIndex ?? Math.max(...alreadyFinalisedWitnessIndices)
			}
		}
		return { ok: false, msg: "No my withdrawal index found", status: "waiting" }
	}

	const myWithdrawal = innerActions[myWithdrawalIndex]
	const withdrawalParams = findMatchingWithdrawal(myWithdrawal)
	if (!withdrawalParams) throw new Error("Unreachable: Did not find withdrawal parameters")
	debug(runtime, "fetchWithdrawalFinalizationWitnesses selectedWithdrawal", {
		index: myWithdrawal.index,
		actionHash: myWithdrawal.hash,
		recipient: withdrawalParams.withdrawal.recipient.toBase58(),
		amount: withdrawalParams.withdrawal.amount.toString()
	})
	try {
		assertFirstWithdrawalAmountCanCreateHelper({
			helperAccountExists: helperAccount !== null,
			amount: withdrawalParams.withdrawal.amount,
			recipient: withdrawalParams.withdrawal.recipient,
			accountCreationFee: minimumFirstWithdrawalAmount(runtime)
		})
	} catch (e) {
		if (e instanceof InsufficientFirstWithdrawalAmountError) {
			return { ok: false, msg: e.message }
		}
		throw e
	}

	const withdrawalAse = innerActions
		.slice(myWithdrawalIndex + 1)
		.map(({ action }) => fromList([action]).hash)

	return {
		ok: true,
		index: myWithdrawal.index,
		value: {
			commitAseTarget,
			commitSlotRange: lastCommit.slotRange,
			withdrawalParams,
			helperAccount,
			witness: {
				withdrawalParams: {
					amount: withdrawalParams.withdrawal.amount.toString(),
					recipient: withdrawalParams.withdrawal.recipient.toBase58(),
					children: "[]"
				},
				prevNextWithdrawal: prevNextWithdrawal.toString(),
				withdrawalAse: {
					fields: withdrawalAse.map((elem) => elem.toString()),
					stmt: {
						length: lastCommit.innerActionStateLength.sub(withdrawalAse.length).toString(),
						actionState: myWithdrawal.afterActionState.toString()
					}
				},
				beforeWithdrawal: {
					actionState: myWithdrawal.beforeActionState.toString()
				},
				commitAse: {
					fields: lastCommitAse.map((elem) => elem.toString()),
					stmt: { actionState: lastCommit.afterActionState.toString() }
				},
				commit: {
					actions: lastCommit.action.map((a) => a.toString())
				},
				beforeCommit: { actionState: lastCommit.beforeActionState.toString() },
				publicKey: outerHolder.toBase58()
			}
		}
	}
}

export async function finalizeWithdrawal(
	runtime: BridgeRuntime,
	pk: PublicKey,
	signTxn: SignTransaction,
	_outerHolder?: PublicKey,
	options?: RetryableTransactionOptions
): Promise<string> {
	const { fee } = normalizeRetryableTransactionOptions(options)
	const outerHolder = _outerHolder ?? runtime.outerHolders[0]
	const witnesses = await fetchWithdrawalFinalizationWitnesses(runtime, pk, outerHolder)

	if (!witnesses.ok) throw new Error("Did not find any withdrawal to finalize")

	const { witness, withdrawalParams, commitAseTarget, commitSlotRange } = witnesses.value

	setL1(runtime)
	await refreshCache(withdrawalParams.withdrawal.recipient)
	await refreshCache(withdrawalParams.withdrawal.recipient, TokenId.derive(runtime.outerTokenOwner))
	await refreshCache(runtime.outerTokenOwner)
	await refreshCache(outerHolder)

	const withdrawalIndex = Field(witness.withdrawalAse.stmt.length).sub(1)

	let isHelperAccountNew = false
	const txn = await Mina.transaction(
		{
			sender: runtime.sequencerPk,
			fee
		},
		async () => {
			const helperAccount = AccountUpdate.createSigned(
				withdrawalParams.withdrawal.recipient,
				TokenId.derive(runtime.outerTokenOwner)
			)
			helperAccount.body.useFullCommitment = Bool(false)
			helperAccount.body.incrementNonce = Bool(true)
			helperAccount.body.implicitAccountCreationFee = Bool(false)
			helperAccount.body.mayUseToken = {
				parentsOwnToken: Bool(true),
				inheritFromParent: Bool(false)
			}
			helperAccount.body.update.appState[1] = {
				isSome: Bool(true),
				value: withdrawalIndex.add(1) // next withdrawal
			}
			helperAccount.account.isNew.getAndRequireEquals()
			Provable.asProver(() => {
				isHelperAccountNew = helperAccount.body.preconditions.account.isNew.value.toBoolean()
			})
			helperAccount.body.preconditions.account.state[1] = {
				isSome: Bool(true),
				value: Field(witness.prevNextWithdrawal)
			}
			helperAccount.account.nonce.getAndRequireEquals()

			const tokenOwner = AccountUpdate.create(runtime.outerTokenOwner)
			tokenOwner.approve(helperAccount)
			tokenOwner.body.useFullCommitment = Bool(true)
			tokenOwner.body.implicitAccountCreationFee = Bool(true)
			tokenOwner.body.mayUseToken = {
				parentsOwnToken: Bool(false),
				inheritFromParent: Bool(false)
			}
			tokenOwner.body.authorizationKind = {
				isSigned: Bool(false),
				isProved: Bool(true),
				verificationKeyHash: await getVkHash(runtime.outerTokenOwner)
			}

			const outerWitness = AccountUpdate.create(runtime.outerPk)
			outerWitness.body.useFullCommitment = Bool(true)
			outerWitness.body.implicitAccountCreationFee = Bool(true)
			outerWitness.body.mayUseToken = {
				parentsOwnToken: Bool(false),
				inheritFromParent: Bool(false)
			}
			outerWitness.body.preconditions.account.state[1] = {
				isSome: Bool(true),
				value: Field(0) // status flags
			}
			outerWitness.body.preconditions.account.actionState = {
				isSome: Bool(true),
				value: commitAseTarget
			}
			outerWitness.body.preconditions.validWhile = {
				isSome: Bool(true),
				value: {
					lower: commitSlotRange.upper.add(runtime.withdrawalDelay),
					upper: UInt32.from(4294967295)
				}
			}

			const recipientPayout = AccountUpdate.create(withdrawalParams.withdrawal.recipient)
			recipientPayout.body.useFullCommitment = Bool(true)
			recipientPayout.body.implicitAccountCreationFee = Bool(true)
			recipientPayout.body.mayUseToken = {
				parentsOwnToken: Bool(true),
				inheritFromParent: Bool(false)
			}
			let payout = withdrawalParams.withdrawal.amount
			payout = payout.sub(runtime.bridgeProofFee)
			if (isHelperAccountNew) payout = payout.sub(runtime.l1AccountCreationFee)
			recipientPayout.balance.addInPlace(payout)

			const feePayout = AccountUpdate.create(runtime.bridgeFeeRecipientL1)
			feePayout.body.useFullCommitment = Bool(true)
			feePayout.body.implicitAccountCreationFee = Bool(true)
			feePayout.body.mayUseToken = {
				parentsOwnToken: Bool(true),
				inheritFromParent: Bool(false)
			}
			feePayout.balance.addInPlace(runtime.bridgeProofFee)

			const finalizeWithdrawal = AccountUpdate.create(outerHolder)
			finalizeWithdrawal.approve(tokenOwner)
			finalizeWithdrawal.approve(outerWitness)
			finalizeWithdrawal.approve(recipientPayout)
			finalizeWithdrawal.approve(feePayout)
			finalizeWithdrawal.body.useFullCommitment = Bool(true)
			finalizeWithdrawal.body.implicitAccountCreationFee = Bool(true)
			finalizeWithdrawal.body.mayUseToken = {
				parentsOwnToken: Bool(false),
				inheritFromParent: Bool(false)
			}
			finalizeWithdrawal.balance.subInPlace(withdrawalParams.withdrawal.amount)
			finalizeWithdrawal.body.events = Events.pushEvent(finalizeWithdrawal.body.events, [
				withdrawalIndex,
				Field(0), // empty children
				...UInt64.from(withdrawalParams.withdrawal.amount).toFields(),
				...withdrawalParams.withdrawal.recipient.toFields()
			])
			finalizeWithdrawal.body.authorizationKind = {
				isSigned: Bool(false),
				isProved: Bool(true),
				verificationKeyHash: await getVkHash(outerHolder)
			}
			AccountUpdate.attachToTransaction(finalizeWithdrawal)
		}
	)

	const signed = await signTxn(txn)
	const helperAccountUpdate = signed.transaction.accountUpdates.find(
		({ publicKey, tokenId }) =>
			publicKey.equals(withdrawalParams.withdrawal.recipient).toBoolean() &&
			tokenId.equals(TokenId.derive(runtime.outerTokenOwner)).toBoolean()
	)
	if (!helperAccountUpdate) throw new Error("Helper account update not found")

	const helperAccountNonce =
		helperAccountUpdate.body.preconditions.account.nonce.value.lower.toString()

	const helperAccountSignatureString = helperAccountUpdate.authorization.signature
	if (!helperAccountSignatureString) throw new Error("Helper account update not signed")
	const helperAccountSignature = Signature.fromBase58(helperAccountSignatureString)

	const { data, error } = await runtime.l2Client().mutation(finalizeWithdrawalMutation, {
		input: {
			...witness,
			prevNonce: helperAccountNonce,
			helperAccountSignature: {
				scalar: helperAccountSignature.s.toBigInt().toString(),
				field: helperAccountSignature.r.toBigInt().toString()
			},
			helperAccountNew: isHelperAccountNew
		}
	})
	if (!data?.request?.key) throw new Error(error?.message ?? "No key returned from mutation")

	return await pollProvingResult(runtime, data.request.key)
}

export async function canFinalizeWithdrawal(
	runtime: BridgeRuntime,
	pk: PublicKey
): Promise<WithdrawalFinalizationResult> {
	debug(runtime, "canFinalizeWithdrawal start", { pk: pk.toBase58() })
	const result = await fetchWithdrawalFinalizationWitnesses(runtime, pk, runtime.outerTokenOwner)
	debug(runtime, "canFinalizeWithdrawal result", result)
	return {
		available: result.ok,
		reason: result.ok ? null : result.msg,
		status: result.ok ? "available" : result.status ?? "waiting",
		index: result.index
	}
}

export async function fetchWithdrawalsWithStates(
	runtime: BridgeRuntime,
	pk: PublicKey
): Promise<{
	withdrawals: WithdrawalWithState[]
	committedIndex: number
	finalisedIndex: number
}> {
	const withdrawals =
		(await runtime.bridge?.fetchUserWithdrawalActions?.(pk)) ??
		(await fetchUserWithdrawalActions(runtime, pk))

	const auxes = withdrawals.map(withdrawalAux)

	const auxesMap = new Map<bigint, Action & Withdrawal>()
	for (const withdrawal of withdrawals) {
		auxesMap.set(withdrawalAux(withdrawal).toBigInt(), withdrawal)
	}

	const withdrawalWitnesses = await fetchInnerWitnessesFromAuxes(
		runtime.actionsApiClient,
		auxes.map((x) => x.toString())
	)

	const helperAccount = await (runtime.bridge?.fetchAccount ?? fetchAccount)(
		runtime.l1Client,
		pk,
		TokenId.derive(runtime.outerTokenOwner)
	)
	const nextWithdrawal = helperAccount ? getNextWithdrawalIndex(helperAccount) : UInt32.zero

	const currentSlot = await (runtime.bridge?.fetchCurrentSlot?.() ?? fetchCurrentSlot(runtime))

	const { commit: lastCommit } = await fetchCommitAsePastSlot(
		runtime.actionsApiClient,
		+currentSlot.sub(runtime.withdrawalDelay)
	)

	const normalizeTimestamp = (timestamp: string) => (timestamp === "0" ? "" : timestamp)
	const isFinalised = (index: number) =>
		nextWithdrawal.greaterThanOrEqual(UInt32.from(index + 1)).toBoolean()
	const isCommitted = (index: number) =>
		isFinalised(index) ||
		(lastCommit === null
			? false
			: lastCommit.innerActionStateLength.greaterThan(UInt32.from(index)).toBoolean())

	const witnessedAuxes = new Set(
		withdrawalWitnesses.map((witness) => witness.aux.toBigInt().toString())
	)
	const provisionalWithdrawals = withdrawals
		.filter((withdrawal) => !witnessedAuxes.has(withdrawalAux(withdrawal).toBigInt().toString()))
		.map((withdrawal) => ({
			...withdrawal,
			timestamp: normalizeTimestamp(withdrawal.timestamp),
			index: withdrawal.index,
			committed: isCommitted(withdrawal.index),
			finalised: isFinalised(withdrawal.index),
			bridgeVersion: bridgeVersionForActionIndex({
				actionIndex: withdrawal.index,
				v2StartIndex: runtime.V2_WITHDRAWALS_START_INDEX
			})
		}))
	const currentWithdrawalStatuses: WithdrawalWithState[] = [
		...withdrawalWitnesses.map((witness) => {
			const withdrawal = auxesMap.get(witness.aux.toBigInt())
			if (!withdrawal) throw new Error("Unreachable: Did not find withdrawal")
			return {
				...withdrawal,
				...witness,
				timestamp: normalizeTimestamp(witness.timestamp),
				committed: isCommitted(witness.index),
				finalised: isFinalised(witness.index),
				bridgeVersion: bridgeVersionForActionIndex({
					actionIndex: witness.index,
					v2StartIndex: runtime.V2_WITHDRAWALS_START_INDEX
				})
			}
		}),
		...provisionalWithdrawals
	]

	return {
		withdrawals: currentWithdrawalStatuses,
		committedIndex:
			lastCommit === null ? -1 : +safeDecrement(lastCommit.innerActionStateLength).toString(),
		finalisedIndex: +safeDecrement(nextWithdrawal).toString()
	}
}
