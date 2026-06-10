import { accountQuery, runtimeConfigQuery } from "@zeko-labs/graphql"
import { type Field, Mina, type PublicKey, TokenId, UInt32 } from "o1js"
import * as v from "valibot"
import type { GqlClient } from "./graphql"
import type { BridgeRuntime } from "./runtime"

export const setL1 = (runtime: BridgeRuntime): void => {
	Mina.setActiveInstance(
		Mina.Network({
			mina: runtime.config.l1Url,
			archive: runtime.config.l1ArchiveUrl,
			networkId: runtime.config.l1Network
		})
	)
}

export const setL2 = (runtime: BridgeRuntime): void => {
	Mina.setActiveInstance(
		Mina.Network({
			mina: runtime.config.zekoUrl,
			archive: runtime.config.zekoArchiveUrl,
			networkId: runtime.config.l2Network
		})
	)
}

export const fetchCurrentSlot = async (runtime: BridgeRuntime): Promise<UInt32> => {
	const { data } = await runtime.l1Client().query(runtimeConfigQuery, {})

	const result = v.safeParse(
		v.object({
			proof: v.object({ fork: v.object({ global_slot_since_genesis: v.number() }) }),
			genesis: v.object({ genesis_state_timestamp: v.string() })
		}),
		data?.runtimeConfig
	)
	if (!result.success) throw new Error("Invalid runtime config")

	const currentTimestamp = Date.now() / 1000
	const forkSlot = result.output.proof.fork.global_slot_since_genesis
	const genesisTimestamp = Date.parse(result.output.genesis.genesis_state_timestamp) / 1000

	return UInt32.from(Math.floor(forkSlot + (currentTimestamp - genesisTimestamp) / 180))
}

export const fetchAccount = async (
	client: GqlClient,
	pk: PublicKey,
	tokenId?: Field
): Promise<{ zkappState: string[] | null } | null> => {
	const { data } = await client().query(accountQuery, {
		pk: pk.toBase58(),
		tokenId: tokenId ? TokenId.toBase58(tokenId) : null
	})
	if (!data) throw new Error("Error getting account data")
	return data.account
}
