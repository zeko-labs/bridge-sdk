import { UInt32, UInt64 } from "o1js"
import { Bridge } from "../src/index"
import { readBridgeConfig, readMinaPrivateKey } from "./helper"

const signer = readMinaPrivateKey()
const recipient = signer.toPublicKey()

async function main() {
	const bridge = await Bridge.init(readBridgeConfig())

	const depositParams = {
		recipient,
		amount: UInt64.from(2_000_000_000),
		timeout: UInt32.from(1_000_000),
		holderAccountL1: bridge.outerHolders[0]
	}

	const txnHash = await bridge.submitDeposit(
		{ sender: depositParams.recipient, fee: 0.1 * 10e8 },
		depositParams,
		async (txn) => txn.sign([signer])
	)

	console.log(txnHash)
}

main().catch(console.error)
