import { provedResultQuery } from "@zeko-labs/graphql"
import { debug, type BridgeRuntime } from "./runtime"

const parseProvingResult = (
	key: string,
	result: string
): { proved?: unknown; executed?: string } => {
	try {
		return JSON.parse(result)
	} catch (error) {
		const reason = error instanceof Error ? `: ${error.message}` : ""
		throw new Error(`Invalid proving result JSON for key ${key}${reason}`)
	}
}

export const pollProvingResult = async (
	runtime: BridgeRuntime,
	key: string,
	pollPeriod = 5_000
): Promise<string> => {
	debug(runtime, "pollQuery", { key })

	let attempts = 0

	while (true) {
		if (
			typeof runtime.config.pollTimeout === "number" &&
			runtime.config.pollTimeout >= 0 &&
			attempts > runtime.config.pollTimeout / pollPeriod
		) {
			throw new Error("Failed to fetch proved forest")
		}

		await new Promise((resolve) => setTimeout(resolve, pollPeriod))
		attempts++
		debug(runtime, "pollQuery waiting", { key, attempts, pollPeriod })

		const resultResponse = await runtime.l2Client().query(provedResultQuery, { key })
		if (resultResponse.error) throw resultResponse.error
		const result = resultResponse.data?.provingResult ?? null

		if (!result) continue

		const resultObject = parseProvingResult(key, result)

		if (resultObject.proved) {
			continue
		}

		if (resultObject.executed) {
			return resultObject.executed
		}

		throw new Error(`Unsupported proving result payload for key ${key}`)
	}
}
