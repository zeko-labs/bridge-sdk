import { diagnoseBridgeHistory } from "../src/diagnostics"
import { readBridgeConfig, readMinaPrivateKey, writeLog } from "./helper"

async function main() {
	const walletAddress = readMinaPrivateKey().toPublicKey().toBase58()

	const diagnostics = await diagnoseBridgeHistory({
		walletAddress,
		config: readBridgeConfig()
	})

	console.log(JSON.stringify(diagnostics, null, 2))
	writeLog({ log: diagnostics, name: "bridge-history-diagnostics" })
}

main().catch((error) => {
	console.error(error)
	process.exitCode = 1
})
