import { env } from "node:process"
import { diagnoseBridgeHistory } from "../src/diagnostics"
import { writeLog } from "./write-log"

async function main() {
	const walletAddress = env.WALLET_ADDRESS
	if (!walletAddress) {
		throw new Error("WALLET_ADDRESS is not set")
	}

	const readEnv = (key: string, fallback: string): string => env[key] ?? fallback

	const diagnostics = await diagnoseBridgeHistory({
		walletAddress,
		config: {
			l1Url: readEnv("L1_URL", "https://api.minascan.io/node/devnet/v1/graphql"),
			l1ArchiveUrl: readEnv("L1_ARCHIVE_URL", "https://api.minascan.io/archive/devnet/v1/graphql"),
			actionsApi: readEnv("ACTIONS_API_URL", "https://api.actions.zeko.io/graphql"),
			zekoUrl: readEnv("L2_URL", "https://testnet.zeko.io/graphql"),
			zekoArchiveUrl: readEnv("L2_ARCHIVE_URL", "https://archive.testnet.zeko.io/graphql"),
			l1Network: "testnet",
			l2Network: "testnet"
		}
	})

	console.log(JSON.stringify(diagnostics, null, 2))
	writeLog({ log: diagnostics, name: "bridge-history-diagnostics" })
}

main().catch((error) => {
	console.error(error)
	process.exitCode = 1
})
