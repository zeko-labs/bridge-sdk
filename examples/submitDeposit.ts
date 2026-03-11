import { env } from "node:process"
import { PrivateKey, UInt32, UInt64 } from "o1js"
import { Bridge } from "../src/index"

if (!env.MINA_PRIVATE_KEY) {
	throw new Error("MINA_PRIVATE_KEY is not set")
}

const signer = PrivateKey.fromBase58(env.MINA_PRIVATE_KEY)
const recipient = signer.toPublicKey()

async function main() {
	const bridge = await Bridge.init({
		l1Url: "https://api.minascan.io/node/devnet/v1/graphql",
		l1ArchiveUrl: "https://api.minascan.io/archive/devnet/v1/graphql",
		actionsApi: "http://api.actions.zeko.io/graphql",
		zekoUrl: "https://testnet.zeko.io/graphql",
		zekoArchiveUrl: "https://archive.testnet.zeko.io/graphql",
		l1Network: "testnet",
		l2Network: "testnet"
	})

	const depositParams = {
		recipient,
		amount: UInt64.from(150 * 10e8),
		timeout: UInt32.from(10),
		holderAccountL1: bridge.outerHolders[0]
	}

	const txn = await bridge.submitDeposit(
		{ sender: depositParams.recipient, fee: 0.1 * 10e8 },
		depositParams
	)

	console.log(txn.toPretty())

	const result = await txn.sign([signer]).send()

	console.log(result.hash)
}

main().catch(console.error)
