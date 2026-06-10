import { Bridge } from "../src/index"
import { readBridgeConfig, readMinaPrivateKey } from "./helper"

const signer = readMinaPrivateKey()
const recipient = signer.toPublicKey()

async function main() {
	const bridge = await Bridge.init(readBridgeConfig())

	const result = await bridge.canFinalizeWithdrawal(recipient)
	console.log("canFinalizeWithdrawal", result)
}

main().catch(console.error)
