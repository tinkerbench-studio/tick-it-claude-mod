// Uploads a ticket's pictures to Tick-it's storage instead of committing them.
//   node scripts/upload-screenshots.mjs plan <dir>                    prints the { name, type } of each picture in <dir>
//   node scripts/upload-screenshots.mjs put <dir> <presigned.json>    PUTs each file and prints the confirm_screenshot arguments
// A script cannot call MCP tools, so the session calls presign_screenshot_upload between the two steps and
// confirm_screenshot after (the upload-screenshots skill walks through it). A name is the file's own name, no path.
// Exit 0 when every PUT succeeded, 1 when one failed, 2 on a wrong call.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' }
export const typeOf = name => TYPES[name.slice(name.lastIndexOf('.')).toLowerCase()]

/** The picture files directly in a folder, as { name, type }. */
export function plan(dir) {
  return readdirSync(dir)
    .filter(n => typeOf(n) && statSync(join(dir, n)).isFile())
    .sort()
    .map(name => ({ name, type: typeOf(name) }))
}

/** PUTs each presigned upload ({ name, url, headers }) with the file of that name in dir. Answers { confirm, failed }. */
export async function put(dir, presigned, send = fetch) {
  const confirm = []
  const failed = []
  for (const entry of presigned) {
    const { name, url, headers } = entry ?? {}
    if (typeof name !== 'string' || name !== basename(name) || !typeOf(name) || typeof url !== 'string') {
      failed.push({ name: String(name), reason: 'not a picture file name with a url' })
      continue
    }
    try {
      const response = await send(url, { method: 'PUT', headers: headers ?? {}, body: readFileSync(join(dir, name)) })
      if (response.ok) confirm.push({ name })
      else failed.push({ name, reason: `PUT answered ${response.status}` })
    } catch (error) {
      failed.push({ name, reason: error instanceof Error ? error.message : String(error) })
    }
  }
  return { confirm, failed }
}

async function main([command, dir, file]) {
  if (command === 'plan' && dir) {
    try {
      console.log(JSON.stringify(plan(dir), null, 2))
    } catch (error) {
      console.error(`${dir}: ${error.message}`)
      return 2
    }
    return 0
  }
  if (command === 'put' && dir && file) {
    let presigned
    try {
      presigned = JSON.parse(readFileSync(file, 'utf8'))
      if (!Array.isArray(presigned)) throw new Error('not a JSON array')
    } catch (error) {
      console.error(`${file}: ${error.message}`)
      return 2
    }
    const { confirm, failed } = await put(dir, presigned)
    console.log(JSON.stringify({ confirm }, null, 2))
    for (const f of failed) console.error(`${f.name}: ${f.reason}`)
    return failed.length === 0 ? 0 : 1
  }
  console.error('usage: node scripts/upload-screenshots.mjs plan <dir> | put <dir> <presigned.json>')
  return 2
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2))
