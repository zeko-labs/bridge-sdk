import { describe, expect, it, vi } from "vitest"
import { PublicKey, UInt64 } from "o1js"
import {
	assertFirstWithdrawalAmountCanCreateHelper,
	ensureFirstWithdrawalAmountCanCreateHelper,
	InsufficientFirstWithdrawalAmountError,
	isInsufficientFirstWithdrawalAmountError
} from "../src/errors"

const recipient = PublicKey.fromBase58("B62qpuhMDp748xtE77iBXRRaipJYgs6yumAeTzaM7zS9dn8avLPaeFF")

describe("first withdrawal amount guard", () => {
	it("throws a protocol error when the helper account is missing and the amount is below the l1 fee", () => {
		expect(() =>
			assertFirstWithdrawalAmountCanCreateHelper({
				helperAccountExists: false,
				amount: UInt64.from(200_000_000),
				recipient,
				accountCreationFee: UInt64.from(1_000_000_000)
			})
		).toThrow(InsufficientFirstWithdrawalAmountError)

		expect(() =>
			assertFirstWithdrawalAmountCanCreateHelper({
				helperAccountExists: false,
				amount: UInt64.from(200_000_000),
				recipient,
				accountCreationFee: UInt64.from(1_000_000_000)
			})
		).toThrow(/First Zeko->Mina withdrawal amount is too small/)
	})

	it("allows first withdrawals that can cover the l1 account creation fee", () => {
		expect(() =>
			assertFirstWithdrawalAmountCanCreateHelper({
				helperAccountExists: false,
				amount: UInt64.from(1_000_000_000),
				recipient,
				accountCreationFee: UInt64.from(1_000_000_000)
			})
		).not.toThrow()
	})

	it("skips the helper-account lookup when the withdrawal already meets the threshold", async () => {
		const helperAccountExists = vi.fn(() => false)

		await expect(
			ensureFirstWithdrawalAmountCanCreateHelper({
				amount: UInt64.from(1_000_000_000),
				recipient,
				accountCreationFee: UInt64.from(1_000_000_000),
				helperAccountExists
			})
		).resolves.toBeUndefined()

		expect(helperAccountExists).not.toHaveBeenCalled()
	})

	it("checks for an existing helper account before failing small withdrawals", async () => {
		const helperAccountExists = vi.fn(() => true)

		await expect(
			ensureFirstWithdrawalAmountCanCreateHelper({
				amount: UInt64.from(200_000_000),
				recipient,
				accountCreationFee: UInt64.from(1_000_000_000),
				helperAccountExists
			})
		).resolves.toBeUndefined()

		expect(helperAccountExists).toHaveBeenCalledTimes(1)
	})

	it("fails small withdrawals when the helper account is still missing", async () => {
		const helperAccountExists = vi.fn(() => false)

		await expect(
			ensureFirstWithdrawalAmountCanCreateHelper({
				amount: UInt64.from(200_000_000),
				recipient,
				accountCreationFee: UInt64.from(1_000_000_000),
				helperAccountExists
			})
		).rejects.toThrow(InsufficientFirstWithdrawalAmountError)

		expect(helperAccountExists).toHaveBeenCalledTimes(1)
	})

	it("detects the shared terminal error by instance or message", () => {
		const error = new InsufficientFirstWithdrawalAmountError({
			amountNanomina: 200_000_000n,
			accountCreationFeeNanomina: 1_000_000_000n,
			recipient: recipient.toBase58()
		})

		expect(isInsufficientFirstWithdrawalAmountError(error)).toBe(true)
		expect(isInsufficientFirstWithdrawalAmountError(error.message)).toBe(true)
		expect(isInsufficientFirstWithdrawalAmountError(new Error("something else"))).toBe(false)
	})
})
