import {
	type cancelDepositMutation,
	finalizeDepositMutation,
	submitDepositMutation
} from "@zeko-labs/graphql"
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
	Deposit,
	DepositWithState,
	ExtractInput,
	OuterAction,
	OuterCommit,
	OuterWitness,
	WitnessFetchResult
} from "./types"
import {
	bridgeVersionForActionIndex,
	checkAccepted,
	depositAux,
	fetchActions,
	fetchCommitAsePastSlot,
	fetchOuterActionsFromIndexer,
	fetchOuterWitnessesFromAuxes,
	filterNulls,
	getBridgeDeployBlock,
	getNextCancelledDepositIndex,
	getNextDepositIndex,
	getVkHash,
	refreshCache,
	safeDecrement,
	uint32Max
} from "./utils"

export type DepositParams = {
	deposit: Deposit
	aux: Field
}

const NO_OUTER_COMMIT_REASON = "No outer commit available yet"

export type DepositStateContext = {
	helperAccountL1: Account | null
	helperAccountL2: Account | null
	prevNextCancelledDeposit: UInt32
	prevNextDeposit: UInt32
	syncedOuterActionState: {
		state: Field
		length: UInt32
	}
	lastCommit: OuterCommit | null
	lastCommitAse: Field[]
	lastCommitIndex: number
	commitAseTarget: Field
	synchronizedOuterActionStateIndex: number
	currentSyncedOuterActionStateIndex: number
	depositWitnesses: OuterWitness[]
	depositsByAux: Map<bigint, DepositParams>
	outerActions: OuterAction[]
	v2DepositsStartIndex: UInt32
}

export async function fetchUserDeposits(runtime: BridgeRuntime, pk: PublicKey): Promise<Deposit[]> {
	const userOuterActions = await fetchActions(
		runtime.l1ArchiveClient,
		pk,
		getBridgeDeployBlock(runtime.config.l1Network)
	)

	return filterNulls(
		userOuterActions.map(({ action }) => {
			const [
				recipient1,
				recipient2,
				amount1,
				timeout1,
				holderAccount1,
				holderAccount2,
				outer1,
				outer2
			] = action

			if (
				!recipient1 ||
				!recipient2 ||
				!amount1 ||
				!timeout1 ||
				!holderAccount1 ||
				!holderAccount2 ||
				!outer1 ||
				!outer2
			)
				return null

			const recipient = PublicKey.fromFields([recipient1, recipient2])
			const amount = UInt64.fromFields([amount1])
			const timeout = UInt32.fromFields([timeout1])
			const holderAccountL1 = PublicKey.fromFields([holderAccount1, holderAccount2])
			const outerPk = PublicKey.fromFields([outer1, outer2])

			if (!outerPk.equals(runtime.outerPk).toBoolean()) return null

			if (!runtime.outerHolders.some((holder) => holder.equals(holderAccountL1).toBoolean()))
				return null

			return {
				recipient,
				amount,
				timeout,
				holderAccountL1
			}
		})
	)
}

export async function fetchSyncedOuterActionState(
	runtime: BridgeRuntime
): Promise<{ state: Field; length: UInt32 }> {
	const innerAccount = await (runtime.bridge?.fetchAccount ?? fetchAccount)(
		runtime.l2Client,
		runtime.innerPk
	)

	if (!innerAccount || !innerAccount.zkappState) throw new Error("Inner account not found")
	const [state, length] = innerAccount.zkappState
	return {
		state: Field.from(state),
		length: UInt32.from(length)
	}
}

export async function fetchDepositStateContext(
	runtime: BridgeRuntime,
	pk: PublicKey
): Promise<DepositStateContext> {
	const deposits = (
		await (runtime.bridge?.fetchUserDeposits?.(pk) ?? fetchUserDeposits(runtime, pk))
	).map((deposit) => ({
		deposit,
		aux: depositAux(deposit)
	}))

	const depositsByAux = new Map<bigint, DepositParams>()

	for (const deposit of deposits) {
		depositsByAux.set(deposit.aux.toBigInt(), deposit)
	}

	const depositWitnesses =
		deposits.length === 0
			? []
			: await fetchOuterWitnessesFromAuxes(
					runtime.actionsApiClient,
					deposits.map(({ aux }) => aux.toString())
				)

	const [helperAccountL1, helperAccountL2, syncedOuterActionState, currentSlot] = await Promise.all(
		[
			(runtime.bridge?.fetchAccount ?? fetchAccount)(
				runtime.l1Client,
				pk,
				TokenId.derive(runtime.outerTokenOwner)
			),
			(runtime.bridge?.fetchAccount ?? fetchAccount)(
				runtime.l2Client,
				pk,
				TokenId.derive(runtime.innerHolder)
			),
			runtime.bridge?.fetchSyncedOuterActionState?.() ?? fetchSyncedOuterActionState(runtime),
			runtime.bridge?.fetchCurrentSlot?.() ?? fetchCurrentSlot(runtime)
		]
	)

	const prevNextCancelledDeposit = helperAccountL1
		? getNextCancelledDepositIndex(helperAccountL1)
		: UInt32.zero
	const prevNextDeposit = helperAccountL2 ? getNextDepositIndex(helperAccountL2) : UInt32.zero

	const { commit: lastCommit, ase } = await fetchCommitAsePastSlot(
		runtime.actionsApiClient,
		+currentSlot.sub(runtime.withdrawalDelay)
	)

	const earliestBeforeState =
		depositWitnesses.length === 0
			? null
			: [...depositWitnesses].sort((a, b) => a.index - b.index).at(0)?.beforeActionState ?? null

	const outerActions =
		earliestBeforeState === null
			? []
			: await fetchOuterActionsFromIndexer(runtime.actionsApiClient, {
					fromState: earliestBeforeState.toString()
				})

	return {
		helperAccountL1,
		helperAccountL2,
		prevNextCancelledDeposit,
		prevNextDeposit,
		syncedOuterActionState,
		lastCommit,
		lastCommitAse: ase.map(({ action }) => fromList([action]).hash),
		lastCommitIndex:
			lastCommit === null ? -1 : outerActions.findIndex(({ index }) => lastCommit.index === index),
		commitAseTarget:
			ase.at(-1)?.afterActionState ?? lastCommit?.afterActionState ?? syncedOuterActionState.state,
		synchronizedOuterActionStateIndex:
			lastCommit === null
				? -1
				: outerActions.findIndex(({ index }) =>
						lastCommit.synchronizedOuterActionStateLength.equals(UInt32.from(index + 1)).toBoolean()
					),
		currentSyncedOuterActionStateIndex: outerActions.findIndex(({ afterActionState }) =>
			afterActionState.equals(syncedOuterActionState.state).toBoolean()
		),
		depositWitnesses,
		depositsByAux,
		outerActions,
		v2DepositsStartIndex: runtime.V2_DEPOSITS_START_INDEX
	}
}

export function getSortedDepositWitnesses(context: DepositStateContext): OuterWitness[] {
	return [...context.depositWitnesses]
		.filter((witness) =>
			context.v2DepositsStartIndex.lessThanOrEqual(UInt32.from(witness.index)).toBoolean()
		)
		.sort((left, right) => left.index - right.index)
}

export function getDepositParamsForWitness(
	context: DepositStateContext,
	witness: OuterWitness
): DepositParams {
	const depositParams = context.depositsByAux.get(witness.aux.toBigInt())
	if (!depositParams) throw new Error("Unreachable: Did not find deposit")
	return depositParams
}

export function isDepositCancelled(context: DepositStateContext, witness: OuterWitness): boolean {
	return context.prevNextCancelledDeposit.greaterThan(UInt32.from(witness.index)).toBoolean()
}

export function isDepositFinalised(context: DepositStateContext, witness: OuterWitness): boolean {
	return context.prevNextDeposit.greaterThanOrEqual(UInt32.from(witness.index + 1)).toBoolean()
}

export async function submitDeposit(
	runtime: BridgeRuntime,
	feePayer: Mina.FeePayerSpec,
	{
		recipient,
		amount,
		timeout,
		holderAccountL1 = runtime.outerHolders[0]
	}: {
		recipient: PublicKey
		amount: UInt64
		timeout: UInt32
		holderAccountL1?: PublicKey
	},
	signTxn: SignTransaction
): Promise<string> {
	setL1(runtime)

	await refreshCache(recipient)
	await refreshCache(feePayer)
	await refreshCache(runtime.outerPk)

	const txn = await Mina.transaction(feePayer, async () => {
		const transferrer = AccountUpdate.createSigned(recipient)
		transferrer.balance.subInPlace(amount.add(runtime.bridgeProofFee))
		transferrer.body.actions = Actions.pushAction(transferrer.body.actions, [
			...recipient.toFields(),
			...amount.toFields(),
			...timeout.toFields(),
			...holderAccountL1.toFields(),
			...runtime.outerPk.toFields()
		])
		transferrer.body.incrementNonce = Bool(true)
		transferrer.account.nonce.getAndRequireEquals()
		transferrer.body.useFullCommitment = Bool(false)

		const receiver = AccountUpdate.create(holderAccountL1)
		receiver.balance.addInPlace(amount)
		receiver.body.useFullCommitment = Bool(true)
		receiver.body.implicitAccountCreationFee = Bool(true)
		receiver.body.mayUseToken = {
			parentsOwnToken: Bool(true),
			inheritFromParent: Bool(false)
		}

		const feePayout = AccountUpdate.create(runtime.bridgeFeeRecipientL1)
		feePayout.balance.addInPlace(runtime.bridgeProofFee)
		feePayout.body.useFullCommitment = Bool(true)
		feePayout.body.implicitAccountCreationFee = Bool(true)
		feePayout.body.mayUseToken = {
			parentsOwnToken: Bool(true),
			inheritFromParent: Bool(false)
		}

		const childrenHash = AccountUpdateForest.fromFlatArray([receiver, feePayout]).hash

		const actionWitness = AccountUpdate.create(runtime.outerPk)
		actionWitness.approve(receiver)
		actionWitness.approve(feePayout)
		actionWitness.body.actions = Actions.pushAction(actionWitness.body.actions, [
			Field(1), // tag
			depositAux({
				recipient,
				amount,
				timeout,
				holderAccountL1
			}), // aux
			childrenHash, // children hash
			Field(0), // lower validWhile
			...UInt32.from(4294967295).toFields() // upper validWhile
		])
		actionWitness.body.useFullCommitment = Bool(true)
		actionWitness.body.implicitAccountCreationFee = Bool(true)
		actionWitness.body.mayUseToken = {
			parentsOwnToken: Bool(false),
			inheritFromParent: Bool(false)
		}
		actionWitness.body.preconditions.account.state[1] = { isSome: Bool(true), value: Field(0) }
		actionWitness.body.preconditions.validWhile = {
			isSome: Bool(true),
			value: { lower: UInt32.from(0), upper: UInt32.from(4294967295) }
		}
		actionWitness.body.authorizationKind = {
			isSigned: Bool(false),
			isProved: Bool(true),
			verificationKeyHash: await getVkHash(runtime.outerPk)
		}

		AccountUpdate.attachToTransaction(actionWitness)
	})

	const signed = await signTxn(txn)

	const transferrer = signed.transaction.accountUpdates.find(({ publicKey }) =>
		publicKey.equals(recipient).toBoolean()
	)
	if (!transferrer) throw new Error("Transferrer not found")

	const { data } = await runtime.l2Client().mutation(submitDepositMutation, {
		depositParams: {
			recipient: recipient.toBase58(),
			amount: amount.toString(),
			timeout: +timeout.toString(),
			holderAccountL1: holderAccountL1.toBase58(),
			children: "[]"
		},
		transferrer: JSON.stringify([AccountUpdate.toJSON(transferrer)])
	})
	if (!data?.request?.key) throw new Error("No key returned from mutation")

	return await pollProvingResult(runtime, data.request.key)
}

export async function fetchDepositFinalizationWitnesses(
	runtime: BridgeRuntime,
	pk: PublicKey
): Promise<
	WitnessFetchResult<{
		aseTarget: {
			state: Field
			length: UInt32
		}
		depositParams: {
			deposit: Deposit
			aux: Field
		}
		helperAccount: Account | null
		witness: ExtractInput<typeof finalizeDepositMutation>
	}>
> {
	setL2(runtime)

	const context = await fetchDepositStateContext(runtime, pk)

	if (context.depositsByAux.size === 0) {
		return { ok: false, msg: "No deposits found" }
	}

	if (context.depositWitnesses.length === 0) {
		return { ok: false, msg: "No deposit witnesses found" }
	}

	if (context.lastCommit === null) {
		return { ok: false, msg: NO_OUTER_COMMIT_REASON }
	}

	const minDepositIndex = uint32Max(context.v2DepositsStartIndex, context.prevNextDeposit)

	for (const witness of getSortedDepositWitnesses(context)) {
		if (
			isDepositCancelled(context, witness) ||
			isDepositFinalised(context, witness) ||
			minDepositIndex.greaterThan(UInt32.from(witness.index)).toBoolean()
		) {
			continue
		}

		if (buildDepositCancellationWitnessInput(context, witness) !== null) {
			continue
		}

		const finalizationWitness = buildDepositFinalizationWitnessValue(context, witness)
		if (finalizationWitness) {
			return {
				ok: true,
				index: witness.index,
				value: finalizationWitness
			}
		}

		return {
			ok: false,
			msg: getDepositFinalizationWaitReason(context, witness)
		}
	}

	return { ok: false, msg: "No finalizable deposit found" }
}

export function getDepositFinalizationWaitReason(
	context: DepositStateContext,
	witness: OuterWitness
): string {
	const accepted = context.lastCommit !== null && context.lastCommit.index >= witness.index
	const confirmed =
		context.lastCommit?.synchronizedOuterActionStateLength
			.greaterThan(UInt32.from(witness.index))
			.toBoolean() ?? false

	if (accepted && !confirmed && context.lastCommit !== null) {
		const confirmedIndex = safeDecrement(
			context.lastCommit.synchronizedOuterActionStateLength
		).toString()

		return `Deposit ${witness.index} is accepted but not confirmed yet; confirmedIndex ${confirmedIndex} is behind deposit index ${witness.index}`
	}

	return "Deposit is not finalizable yet; an earlier deposit must be resolved first"
}

export async function finalizeDeposit(
	runtime: BridgeRuntime,
	pk: PublicKey,
	signTxn: SignTransaction,
	options?: number | RetryableTransactionOptions
): Promise<string> {
	const { attempts, fee } = normalizeRetryableTransactionOptions(options)
	const prove = async (attempts: number) => {
		if (attempts === 0) throw new Error("Failed to prove deposit finalization")

		const witnesses = await fetchDepositFinalizationWitnesses(runtime, pk)

		if (!witnesses.ok) throw new Error(witnesses.msg)

		const { witness, depositParams, aseTarget } = witnesses.value

		setL2(runtime)
		await refreshCache(depositParams.deposit.recipient)
		await refreshCache(depositParams.deposit.recipient, TokenId.derive(runtime.innerHolder))
		await refreshCache(runtime.innerHolder)

		let isHelperAccountNew = false
		const txn = await Mina.transaction(
			{
				sender: runtime.sequencerPk,
				fee
			},
			async () => {
				const helperAccount = AccountUpdate.createSigned(
					depositParams.deposit.recipient,
					TokenId.derive(runtime.innerHolder)
				)
				helperAccount.body.useFullCommitment = Bool(false)
				helperAccount.body.incrementNonce = Bool(true)
				helperAccount.body.implicitAccountCreationFee = Bool(false)
				helperAccount.body.mayUseToken = {
					parentsOwnToken: Bool(true),
					inheritFromParent: Bool(false)
				}
				helperAccount.body.update.appState[0] = {
					isSome: Bool(true),
					value: Field(witness.checkAccepted.init.depositIndex).add(1)
				}
				helperAccount.account.isNew.getAndRequireEquals()
				Provable.asProver(() => {
					isHelperAccountNew = helperAccount.body.preconditions.account.isNew.value.toBoolean()
				})
				helperAccount.body.preconditions.account.state[0] = {
					isSome: Bool(true),
					value: Field(witness.prevNextDeposit)
				}
				helperAccount.account.nonce.getAndRequireEquals()

				const innerWitness = AccountUpdate.create(runtime.innerPk)
				innerWitness.body.useFullCommitment = Bool(true)
				innerWitness.body.implicitAccountCreationFee = Bool(true)
				innerWitness.body.mayUseToken = {
					parentsOwnToken: Bool(false),
					inheritFromParent: Bool(false)
				}
				innerWitness.body.preconditions.account.state[0] = {
					isSome: Bool(true),
					value: aseTarget.state
				}
				innerWitness.body.preconditions.account.state[1] = {
					isSome: Bool(true),
					value: aseTarget.length.toFields()[0]
				}

				const recipientPayout = AccountUpdate.create(depositParams.deposit.recipient)
				recipientPayout.body.useFullCommitment = Bool(true)
				recipientPayout.body.implicitAccountCreationFee = Bool(true)
				recipientPayout.body.mayUseToken = {
					parentsOwnToken: Bool(true),
					inheritFromParent: Bool(false)
				}
				let payout = depositParams.deposit.amount
				payout = payout.sub(runtime.bridgeProofFee)
				if (isHelperAccountNew) payout = payout.sub(runtime.l2AccountCreationFee)
				recipientPayout.balance.addInPlace(payout)

				const feePayout = AccountUpdate.create(runtime.bridgeFeeRecipientL2)
				feePayout.body.useFullCommitment = Bool(true)
				feePayout.body.implicitAccountCreationFee = Bool(true)
				feePayout.body.mayUseToken = {
					parentsOwnToken: Bool(true),
					inheritFromParent: Bool(false)
				}
				feePayout.balance.addInPlace(runtime.bridgeProofFee)

				const finalizeDeposit = AccountUpdate.create(runtime.innerHolder)
				finalizeDeposit.approve(helperAccount)
				finalizeDeposit.approve(innerWitness)
				finalizeDeposit.approve(recipientPayout)
				finalizeDeposit.approve(feePayout)
				finalizeDeposit.body.useFullCommitment = Bool(true)
				finalizeDeposit.body.implicitAccountCreationFee = Bool(true)
				finalizeDeposit.body.mayUseToken = {
					parentsOwnToken: Bool(false),
					inheritFromParent: Bool(false)
				}
				finalizeDeposit.balance.subInPlace(depositParams.deposit.amount)
				finalizeDeposit.body.events = Events.pushEvent(finalizeDeposit.body.events, [
					Field(witness.checkAccepted.init.depositIndex),
					Field(0), // empty children
					...PublicKey.fromBase58(witness.checkAccepted.init.params.holderAccountL1).toFields(),
					...UInt64.from(witness.checkAccepted.init.params.amount).toFields(),
					...PublicKey.fromBase58(witness.checkAccepted.init.params.recipient).toFields(),
					...UInt32.from(witness.checkAccepted.init.params.timeout).toFields()
				])
				finalizeDeposit.body.authorizationKind = {
					isSigned: Bool(false),
					isProved: Bool(true),
					verificationKeyHash: await getVkHash(runtime.innerHolder)
				}
				AccountUpdate.attachToTransaction(finalizeDeposit)
			}
		)

		const signed = await signTxn(txn)
		const helperAccountUpdate = signed.transaction.accountUpdates.find(
			({ publicKey, tokenId }) =>
				publicKey.equals(depositParams.deposit.recipient).toBoolean() &&
				tokenId.equals(TokenId.derive(runtime.innerHolder)).toBoolean()
		)
		if (!helperAccountUpdate) throw new Error("Helper account update not found")

		const helperAccountNonce =
			helperAccountUpdate.body.preconditions.account.nonce.value.lower.toString()

		const helperAccountSignatureString = helperAccountUpdate.authorization.signature
		if (!helperAccountSignatureString) throw new Error("Helper account update not signed")
		const helperAccountSignature = Signature.fromBase58(helperAccountSignatureString)

		const { data, error } = await runtime.l2Client().mutation(finalizeDepositMutation, {
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
		const txnHash = await pollProvingResult(runtime, data.request.key)

		const currentSyncedOuterActionState =
			(await runtime.bridge?.fetchSyncedOuterActionState?.()) ??
			(await fetchSyncedOuterActionState(runtime))

		if (currentSyncedOuterActionState.state.equals(aseTarget.state).toBoolean()) {
			return txnHash
		}
		return await prove(attempts - 1)
	}

	return await prove(attempts)
}

export async function canFinalizeDeposit(
	runtime: BridgeRuntime,
	pk: PublicKey
): Promise<{ available: boolean; reason: string | null; index?: number }> {
	debug(runtime, "canFinalizeDeposit start", { pk: pk.toBase58() })
	const result = await fetchDepositFinalizationWitnesses(runtime, pk)
	debug(runtime, "canFinalizeDeposit result", result)
	return {
		available: result.ok,
		reason: result.ok ? null : result.msg,
		index: result.index
	}
}

function buildDepositFinalizationWitnessValue(
	context: DepositStateContext,
	witness: OuterWitness
): {
	aseTarget: {
		state: Field
		length: UInt32
	}
	depositParams: {
		deposit: Deposit
		aux: Field
	}
	helperAccount: Account | null
	witness: ExtractInput<typeof finalizeDepositMutation>
} | null {
	const depositParams = getDepositParamsForWitness(context, witness)
	const minDepositIndex = uint32Max(context.v2DepositsStartIndex, context.prevNextDeposit)

	if (isDepositCancelled(context, witness) || isDepositFinalised(context, witness)) {
		return null
	}

	if (minDepositIndex.greaterThan(UInt32.from(witness.index)).toBoolean()) {
		return null
	}

	const depositActionIndex = context.outerActions.findIndex(
		(action) =>
			action.type === "witness" &&
			action.index === witness.index &&
			action.aux.equals(witness.aux).toBoolean()
	)

	if (depositActionIndex === -1) {
		return null
	}

	const { isRejected, isAccepted } = checkAccepted(
		context.outerActions,
		UInt32.from(witness.index),
		depositParams.deposit
	)

	if (isRejected || !isAccepted) {
		return null
	}

	const nextCommitIndex = context.outerActions.findIndex(
		(action, index) =>
			index > depositActionIndex &&
			action.type === "commit" &&
			action.synchronizedOuterActionStateLength.greaterThan(UInt32.from(witness.index)).toBoolean()
	)

	if (nextCommitIndex === -1) {
		return null
	}

	if (
		context.currentSyncedOuterActionStateIndex === -1 ||
		context.currentSyncedOuterActionStateIndex < nextCommitIndex
	) {
		return null
	}

	const nextCommit = context.outerActions[nextCommitIndex] as OuterCommit
	const aseElems = context.outerActions
		.slice(nextCommitIndex + 1, context.currentSyncedOuterActionStateIndex + 1)
		.map(({ action }) => fromList([action]).hash)

	return {
		aseTarget: context.syncedOuterActionState,
		depositParams,
		helperAccount: context.helperAccountL2,
		witness: {
			prevNextDeposit: context.prevNextDeposit.toString(),
			checkAccepted: {
				elems: context.outerActions
					.slice(depositActionIndex, nextCommitIndex + 1)
					.map(({ action }) => ({ actions: action.map((field) => field.toString()) })),
				init: {
					depositIndex: witness.index.toString(),
					orignalActionState: witness.beforeActionState.toString(),
					params: {
						amount: depositParams.deposit.amount.toString(),
						recipient: depositParams.deposit.recipient.toBase58(),
						holderAccountL1: depositParams.deposit.holderAccountL1.toBase58(),
						timeout: +depositParams.deposit.timeout,
						children: "[]"
					}
				}
			},
			ase: {
				stmt: {
					length: context.syncedOuterActionState.length.sub(aseElems.length).toString(),
					actionState: nextCommit.afterActionState.toString()
				},
				fields: aseElems.map((elem) => elem.toString())
			}
		}
	}
}

function buildDepositWithState(
	context: DepositStateContext,
	witness: OuterWitness
): DepositWithState {
	const depositParams = getDepositParamsForWitness(context, witness)
	const depositActionIndex = context.outerActions.findIndex(
		(action) =>
			action.type === "witness" &&
			action.index === witness.index &&
			action.aux.equals(witness.aux).toBoolean()
	)
	const acceptanceActions =
		depositActionIndex === -1
			? context.outerActions
			: context.outerActions.slice(depositActionIndex + 1)

	const { isRejected, isAccepted } = checkAccepted(
		acceptanceActions,
		UInt32.from(witness.index),
		depositParams.deposit
	)

	const cancelled = isRejected && isDepositCancelled(context, witness)
	const synced = context.syncedOuterActionState.length
		.greaterThanOrEqual(UInt32.from(witness.index + 1))
		.toBoolean()
	const accepted = context.lastCommit !== null && context.lastCommit.index >= witness.index
	const confirmed =
		context.lastCommit === null
			? false
			: context.lastCommit.synchronizedOuterActionStateLength
					.greaterThanOrEqual(UInt32.from(witness.index + 1))
					.toBoolean()
	const finalised = isAccepted && isDepositFinalised(context, witness)

	return {
		...witness,
		...depositParams.deposit,
		cancelled,
		synced,
		accepted,
		confirmed,
		finalised,
		cancellable: buildDepositCancellationWitnessInput(context, witness) !== null,
		bridgeVersion: bridgeVersionForActionIndex({
			actionIndex: witness.index,
			v2StartIndex: context.v2DepositsStartIndex
		})
	}
}

export function buildDepositCancellationWitnessInput(
	context: DepositStateContext,
	witness: OuterWitness
): Omit<ExtractInput<typeof cancelDepositMutation>, "publicKey"> | null {
	const depositParams = getDepositParamsForWitness(context, witness)

	const { isRejected, isAccepted } = checkAccepted(
		context.outerActions,
		UInt32.from(witness.index),
		depositParams.deposit
	)

	const cancelled = isRejected && isDepositCancelled(context, witness)
	const finalised = isAccepted && isDepositFinalised(context, witness)

	if (cancelled || finalised) return null

	const minDepositIndex = uint32Max(context.v2DepositsStartIndex, context.prevNextCancelledDeposit)

	if (minDepositIndex.greaterThan(UInt32.from(witness.index)).toBoolean()) return null

	const cancellationActionIndex = context.outerActions.findIndex(
		(action) =>
			action.type === "witness" &&
			action.index === witness.index &&
			action.aux.equals(witness.aux).toBoolean()
	)

	if (cancellationActionIndex === -1) return null

	if (context.lastCommitIndex === -1 || context.lastCommitIndex < cancellationActionIndex)
		return null

	if (context.lastCommit === null) return null

	if (context.synchronizedOuterActionStateIndex === -1) return null

	if (!isRejected || isAccepted) return null

	const syncAse = context.outerActions
		.slice(context.synchronizedOuterActionStateIndex + 1)
		.map(({ action }) => fromList([action]).hash)

	return {
		commitAse: {
			fields: context.lastCommitAse.map((elem) => elem.toString()),
			stmt: { actionState: context.lastCommit.afterActionState.toString() }
		},
		commit: {
			actions: context.lastCommit.action.map((action) => action.toString())
		},
		beforeCommit: { actionState: context.lastCommit.beforeActionState.toString() },
		prevNextCancelledDeposit: context.prevNextCancelledDeposit.toString(),
		checkAccepted: {
			elems: context.outerActions
				.slice(cancellationActionIndex, context.lastCommitIndex + 1)
				.map(({ action }) => ({ actions: action.map((field) => field.toString()) })),
			init: {
				depositIndex: witness.index.toString(),
				orignalActionState: witness.beforeActionState.toString(),
				params: {
					amount: depositParams.deposit.amount.toString(),
					recipient: depositParams.deposit.recipient.toBase58(),
					holderAccountL1: depositParams.deposit.holderAccountL1.toBase58(),
					timeout: +depositParams.deposit.timeout,
					children: "[]"
				}
			}
		},
		checkAcceptedAse: {
			fields: context.lastCommitAse.map((elem) => elem.toString()),
			stmt: {
				actionState: context.lastCommit.afterActionState.toString(),
				length: (context.lastCommit.index + 1).toString()
			}
		},
		syncAse: {
			fields: syncAse.map((elem) => elem.toString()),
			stmt: {
				actionState: context.lastCommit.synchronizedOuterActionState.toString(),
				length: context.lastCommit.synchronizedOuterActionStateLength.toString()
			}
		}
	}
}

export async function fetchDepositsWithStates(
	runtime: BridgeRuntime,
	pk: PublicKey
): Promise<{
	deposits: DepositWithState[]
	syncedIndex: number
	acceptedIndex: number
	confirmedIndex: number
	finalisedIndex: number
	cancelledIndex: number
}> {
	const context = await fetchDepositStateContext(runtime, pk)

	return {
		deposits: getSortedDepositWitnesses(context).map((witness) =>
			buildDepositWithState(context, witness)
		),
		syncedIndex: +safeDecrement(context.syncedOuterActionState.length).toString(),
		acceptedIndex: context.lastCommit?.index ?? -1,
		confirmedIndex:
			context.lastCommit === null
				? -1
				: +safeDecrement(context.lastCommit.synchronizedOuterActionStateLength).toString(),
		finalisedIndex: +safeDecrement(context.prevNextDeposit).toString(),
		cancelledIndex: +safeDecrement(context.prevNextCancelledDeposit).toString()
	}
}
