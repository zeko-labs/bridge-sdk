import type { PublicKey, UInt64 } from "o1js"

const NANOMINA_PER_MINA = 1_000_000_000n
const FIRST_WITHDRAWAL_TOO_SMALL_PREFIX = "First Zeko->Mina withdrawal amount is too small"

const formatNanomina = (value: bigint): string => {
	const whole = value / NANOMINA_PER_MINA
	const fraction = (value % NANOMINA_PER_MINA).toString().padStart(9, "0").replace(/0+$/, "")

	return fraction.length > 0 ? `${whole}.${fraction}` : whole.toString()
}

export class InsufficientFirstWithdrawalAmountError extends Error {
	public readonly code = "INSUFFICIENT_FIRST_WITHDRAWAL_AMOUNT"

	constructor({
		amountNanomina,
		accountCreationFeeNanomina,
		recipient
	}: {
		amountNanomina: bigint
		accountCreationFeeNanomina: bigint
		recipient: string
	}) {
		super(
			`${FIRST_WITHDRAWAL_TOO_SMALL_PREFIX}: recipient ${recipient} does not have an L1 helper account yet, so the first withdrawal must be at least ${formatNanomina(accountCreationFeeNanomina)} MINA to cover the Mina account creation fee. This withdrawal is ${formatNanomina(amountNanomina)} MINA and cannot proceed as submitted.`
		)
		this.name = "InsufficientFirstWithdrawalAmountError"
	}
}

export const isInsufficientFirstWithdrawalAmountError = (error: unknown): boolean => {
	if (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { code?: unknown }).code === "INSUFFICIENT_FIRST_WITHDRAWAL_AMOUNT"
	) {
		return true
	}

	const message = error instanceof Error ? error.message : String(error)
	return message.includes(FIRST_WITHDRAWAL_TOO_SMALL_PREFIX)
}

export const assertFirstWithdrawalAmountCanCreateHelper = ({
	helperAccountExists,
	amount,
	recipient,
	accountCreationFee
}: {
	helperAccountExists: boolean
	amount: UInt64
	recipient: PublicKey
	accountCreationFee: UInt64
}): void => {
	if (amount.greaterThanOrEqual(accountCreationFee).toBoolean()) return
	if (helperAccountExists) return

	throw new InsufficientFirstWithdrawalAmountError({
		amountNanomina: amount.toBigInt(),
		accountCreationFeeNanomina: accountCreationFee.toBigInt(),
		recipient: recipient.toBase58()
	})
}

export const ensureFirstWithdrawalAmountCanCreateHelper = async ({
	amount,
	recipient,
	accountCreationFee,
	helperAccountExists
}: {
	amount: UInt64
	recipient: PublicKey
	accountCreationFee: UInt64
	helperAccountExists: () => boolean | Promise<boolean>
}): Promise<void> => {
	if (amount.greaterThanOrEqual(accountCreationFee).toBoolean()) return

	assertFirstWithdrawalAmountCanCreateHelper({
		helperAccountExists: await helperAccountExists(),
		amount,
		recipient,
		accountCreationFee
	})
}
