import { Bridge } from "../src/index"
import { readBridgeConfig, readMinaPrivateKey } from "./helper"

const signer = readMinaPrivateKey()
const recipient = signer.toPublicKey()

async function main() {
	const bridge = await Bridge.init(readBridgeConfig())

	const txnHash = await bridge.cancelDeposit(
		recipient,
		async (txn) => txn.sign([signer]),
		bridge.outerHolders[0]
	)

	console.log(txnHash)
}

main().catch(console.error)
