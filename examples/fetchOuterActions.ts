import { Bridge } from "../src/index"
import { readBridgeConfig, readMinaPrivateKey, writeLog } from "./helper"

const signer = readMinaPrivateKey()
const recipient = signer.toPublicKey()

async function main() {
	const bridge = await Bridge.init(readBridgeConfig())

	const { deposits, ...indices } = await bridge.fetchDepositsWithStates(recipient)
	const formattedActions = deposits.map((deposit) => ({
		index: deposit.index,
		action: deposit.action.map((x) => x.toString()),
		beforeActionState: deposit.beforeActionState.toString(),
		afterActionState: deposit.afterActionState.toString(),
		timestamp: deposit.timestamp,
		hash: deposit.hash,
		recipient: deposit.recipient.toBase58(),
		amount: deposit.amount.toString(),
		timeout: deposit.timeout.toString(),
		holderAccountL1: deposit.holderAccountL1.toBase58(),
		synced: deposit.synced,
		accepted: deposit.accepted,
		confirmed: deposit.confirmed,
		finalised: deposit.finalised,
		cancelled: deposit.cancelled,
		cancellable: deposit.cancellable
	}))

	console.log(formattedActions)
	console.log("formattedActions length", formattedActions.length)
	console.log("indices", indices)

	writeLog({ log: formattedActions, name: "outer-actions" })
}

main().catch(console.error)
