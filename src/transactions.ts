import { UInt64, type Transaction } from "o1js"

export type SignTransaction = (
	txn: Transaction<boolean, false>
) => Promise<Transaction<boolean, true>>

export type RetryableTransactionOptions = {
	attempts?: number
	feeNanomina?: number | bigint
}

const DEFAULT_BRIDGE_FEE_NANOMINA = 1_000_000_000

export const normalizeRetryableTransactionOptions = (
	options: number | RetryableTransactionOptions | undefined
): { attempts: number; fee: UInt64 } => {
	if (typeof options === "number") {
		return {
			attempts: options,
			fee: UInt64.from(DEFAULT_BRIDGE_FEE_NANOMINA)
		}
	}

	return {
		attempts: options?.attempts ?? 5,
		fee: UInt64.from(options?.feeNanomina ?? DEFAULT_BRIDGE_FEE_NANOMINA)
	}
}
