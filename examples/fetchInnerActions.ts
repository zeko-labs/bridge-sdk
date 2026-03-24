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
