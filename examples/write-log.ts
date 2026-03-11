import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

export const writeLog = ({ log, name }: { log: object; name: string }) => {
	try {
		const tmpDir = join(process.cwd(), "tmp")
		mkdirSync(tmpDir, { recursive: true })
		const logPath = join(tmpDir, `${name}-${Date.now()}.log`)
		writeFileSync(logPath, JSON.stringify(log, null, 2), "utf8")
		console.log(`${name} log written to ${logPath}`)
	} catch (e) {
		console.error("Failed to write log:", e)
	}
}
