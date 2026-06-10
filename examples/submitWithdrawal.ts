import { UInt64 } from "o1js"
import { Bridge } from "../src/index"
import { readBridgeConfig, readMinaPrivateKey } from "./helper"

const signer = readMinaPrivateKey()
const recipient = signer.toPublicKey()

async function main() {
	const bridge = await Bridge.init(readBridgeConfig())

	const withdrawalParams = {
		recipient,
		amount: UInt64.from(2_000_000_000)
	}

	const txnHash = await bridge.submitWithdrawal(
		{ sender: withdrawalParams.recipient, fee: 0.5 * 10e8 },
		withdrawalParams,
		async (txn) => txn.sign([signer])
	)

	console.log(txnHash)
}

main().catch(console.error)
