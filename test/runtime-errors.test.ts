import { beforeEach, describe, expect, it, vi } from "vitest"
import { createBridgeRuntime } from "../src/runtime"
import type { Config } from "../src/types"

const mocks = vi.hoisted(() => ({
	queryByUrl: vi.fn()
}))

vi.mock("../src/graphql", () => ({
	createGraphqlClient: (url: string, label: string) =>
		Object.assign(
			() => ({
				query: (query: unknown, variables: unknown) => mocks.queryByUrl(url, query, variables)
			}),
			{ label }
		)
}))

const config: Config = {
	l1Url: "http://l1.test/graphql",
	l1ArchiveUrl: "http://l1-archive.test/graphql",
	zekoUrl: "http://l2.test/graphql",
	zekoArchiveUrl: "http://l2-archive.test/graphql",
	l1Network: "testnet",
	l2Network: "testnet",
	actionsApi: "http://actions.test/graphql"
}

describe("Bridge runtime errors", () => {
	beforeEach(() => {
		mocks.queryByUrl.mockReset()
	})

	it("reports the failing endpoint and query when runtime config fetch fails", async () => {
		mocks.queryByUrl.mockImplementation(async (url: string) =>
			url === config.zekoUrl
				? {
						error: {
							message: "[Network] error code: 502",
							networkError: new Error("error code: 502")
						}
					}
				: { data: { genesisConstants: { accountCreationFee: "1000000000" } } }
		)

		await expect(createBridgeRuntime(config)).rejects.toThrow(
			"GraphQL query FetchConfig failed at http://l2.test/graphql: [Network] error code: 502; networkError=error code: 502"
		)
	})

	it("reports missing runtime fields with the endpoint and query", async () => {
		mocks.queryByUrl.mockImplementation(async (url: string) =>
			url === config.zekoUrl
				? { data: {} }
				: { data: { genesisConstants: { accountCreationFee: "1000000000" } } }
		)

		await expect(createBridgeRuntime(config)).rejects.toThrow(
			"GraphQL query FetchConfig at http://l2.test/graphql did not return circuitsConfig"
		)
	})
})
