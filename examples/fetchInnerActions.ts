import { Bridge } from "../src/index"
import { readBridgeConfig, readMinaPrivateKey, writeLog } from "./helper"

const signer = readMinaPrivateKey()
const recipient = signer.toPublicKey()

async function main() {
	const bridge = await Bridge.init(readBridgeConfig())

	const { withdrawals, ...indices } = await bridge.fetchWithdrawalsWithStates(recipient)
	const formattedActions = withdrawals.map((withdrawal) => ({
		index: withdrawal.index,
		action: withdrawal.action.map((x) => x.toString()),
		beforeActionState: withdrawal.beforeActionState.toString(),
		afterActionState: withdrawal.afterActionState.toString(),
		timestamp: withdrawal.timestamp,
		hash: withdrawal.hash,
		recipient: withdrawal.recipient.toBase58(),
		amount: withdrawal.amount.toString(),
		committed: withdrawal.committed,
		finalised: withdrawal.finalised
	}))

	console.log(formattedActions)
	console.log("formattedActions length", formattedActions.length)
	console.log("indices", indices)

	writeLog({ log: formattedActions, name: "inner-actions" })
}

main().catch(console.error)
