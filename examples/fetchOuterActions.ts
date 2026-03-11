import { env } from "node:process"
import { PrivateKey } from "o1js"
import { Bridge } from "../src/index"
import { writeLog } from "./write-log"

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
		finalised: deposit.finalised
	}))

	console.log(formattedActions)
	console.log("formattedActions length", formattedActions.length)
	console.log("indices", indices)

	writeLog({ log: formattedActions, name: "outer-actions" })
}

main().catch(console.error)
