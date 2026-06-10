import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { cwd, env } from "node:process"
import { PrivateKey, type NetworkId } from "o1js"
import type { Config } from "../src/index"

export const readEnv = (key: string, fallback: string): string => env[key]?.trim() || fallback

type BridgeNetworkId = Extract<NetworkId, "testnet" | "mainnet">

const NETWORK_IDS = ["testnet", "mainnet"] as const satisfies readonly BridgeNetworkId[]

type NetworkDefaults = {
	actionsApi: string
	l1Url: string
	l1ArchiveUrl: string
	l2Url: string
	l2ArchiveUrl: string
}

const NETWORK_DEFAULTS = {
	testnet: {
		actionsApi: "https://testnet.api.actions.zeko.io/graphql",
		l1Url: "https://gateway.mina.devnet.zeko.io",
		l1ArchiveUrl: "https://gateway.mina.archive.devnet.zeko.io",
		l2Url: "https://testnet.zeko.io/graphql",
		l2ArchiveUrl: "https://archive.testnet.zeko.io/graphql"
	},
	mainnet: {
		actionsApi: "https://api.actions.zeko.io/graphql",
		l1Url: "https://gateway.mina.mainnet.zeko.io",
		l1ArchiveUrl: "https://gateway.mina.archive.mainnet.zeko.io",
		l2Url: "https://mainnet.zeko.io/graphql",
		l2ArchiveUrl: "https://archive.mainnet.zeko.io/graphql"
	}
} as const satisfies Record<BridgeNetworkId, NetworkDefaults>

const readNetworkId = (key: string, fallback: BridgeNetworkId): BridgeNetworkId => {
	const value = readEnv(key, fallback)
	if (NETWORK_IDS.includes(value as BridgeNetworkId)) return value as BridgeNetworkId
	throw new Error(`${key} must be one of: ${NETWORK_IDS.join(", ")}`)
}

export const readBridgeConfig = (): Config => {
	const l1Network = readNetworkId("L1_NETWORK", "testnet")
	const l2Network = readNetworkId("L2_NETWORK", "testnet")
	const l1Defaults = NETWORK_DEFAULTS[l1Network]
	const l2Defaults = NETWORK_DEFAULTS[l2Network]

	return {
		l1Url: readEnv("L1_URL", l1Defaults.l1Url),
		l1ArchiveUrl: readEnv("L1_ARCHIVE_URL", l1Defaults.l1ArchiveUrl),
		actionsApi: readEnv("ACTIONS_API_URL", l2Defaults.actionsApi),
		zekoUrl: readEnv("L2_URL", l2Defaults.l2Url),
		zekoArchiveUrl: readEnv("L2_ARCHIVE_URL", l2Defaults.l2ArchiveUrl),
		l1Network,
		l2Network
	}
}

export const readMinaPrivateKey = (): PrivateKey => {
	const privateKey = readEnv("MINA_PRIVATE_KEY", "")
	if (!privateKey) {
		throw new Error("MINA_PRIVATE_KEY is not set")
	}

	return PrivateKey.fromBase58(privateKey)
}

export const writeLog = ({ log, name }: { log: object; name: string }) => {
	try {
		const tmpDir = join(cwd(), "tmp")
		mkdirSync(tmpDir, { recursive: true })
		const logPath = join(tmpDir, `${name}-${Date.now()}.log`)
		writeFileSync(logPath, JSON.stringify(log, null, 2), "utf8")
		console.log(`${name} log written to ${logPath}`)
	} catch (e) {
		console.error("Failed to write log:", e)
	}
}
