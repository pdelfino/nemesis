import { generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto'

/**
 * A self-signed certificate for the fixture server (#46), built here because
 * SECURITY.org T5 forbids a dependency we can do without and `node:crypto`
 * signs but does not issue certificates. So this file encodes the one X.509
 * structure the harness needs, by hand, in DER.
 *
 * The certificate is valid for `localhost` and `127.0.0.1`, lives for a week,
 * and is generated fresh on every run. It is never trusted by the system store:
 * the HTTPS fixtures exist so a spec can watch Nemesis reject an untrusted
 * certificate (SECURITY.org T3), and the harness itself trusts it explicitly.
 */

export interface SelfSignedCertificate {
  /** PEM private key, for `https.createServer`. */
  readonly key: string
  /** PEM certificate, for `https.createServer` and for a spec's `ca` option. */
  readonly certificate: string
}

/** DER length: short form under 128 bytes, long form above. */
function derLength(size: number): Buffer {
  if (size < 0x80) return Buffer.from([size])
  const bytes: number[] = []
  for (let left = size; left > 0; left >>>= 8) bytes.unshift(left & 0xff)
  return Buffer.from([0x80 | bytes.length, ...bytes])
}

function tagged(tag: number, ...body: Buffer[]): Buffer {
  const content = Buffer.concat(body)
  return Buffer.concat([Buffer.from([tag]), derLength(content.length), content])
}

const sequence = (...body: Buffer[]): Buffer => tagged(0x30, ...body)
const asnSet = (...body: Buffer[]): Buffer => tagged(0x31, ...body)
const bitString = (body: Buffer): Buffer => tagged(0x03, Buffer.from([0x00]), body)
const octetString = (body: Buffer): Buffer => tagged(0x04, body)
const utf8String = (text: string): Buffer => tagged(0x0c, Buffer.from(text, 'utf8'))
const asnBoolean = (value: boolean): Buffer => tagged(0x01, Buffer.from([value ? 0xff : 0x00]))
/** A constructed, explicitly tagged field, as in `version [0] EXPLICIT`. */
const explicit = (index: number, ...body: Buffer[]): Buffer => tagged(0xa0 | index, ...body)

/** DER INTEGER: no leading zero bytes, and never read as negative. */
function integer(value: Buffer): Buffer {
  let start = 0
  while (start < value.length - 1 && value[start] === 0x00) start += 1
  const trimmed = value.subarray(start)
  const first = trimmed[0] ?? 0x00
  return tagged(
    0x02,
    (first & 0x80) === 0 ? trimmed : Buffer.concat([Buffer.from([0x00]), trimmed]),
  )
}

function objectIdentifier(dotted: string): Buffer {
  const arcs = dotted.split('.').map((arc) => Number.parseInt(arc, 10))
  const [root, second, ...rest] = arcs
  if (root === undefined || second === undefined) throw new Error(`Not an OID: ${dotted}`)
  const bytes: number[] = [root * 40 + second]
  for (const arc of rest) {
    const chunk: number[] = [arc & 0x7f]
    for (let left = arc >>> 7; left > 0; left >>>= 7) chunk.unshift(0x80 | (left & 0x7f))
    bytes.push(...chunk)
  }
  return tagged(0x06, Buffer.from(bytes))
}

/** UTCTime, the encoding X.509 uses for any year before 2050. */
function utcTime(date: Date): Buffer {
  const pad = (value: number): string => String(value).padStart(2, '0')
  const text =
    pad(date.getUTCFullYear() % 100) +
    pad(date.getUTCMonth() + 1) +
    pad(date.getUTCDate()) +
    pad(date.getUTCHours()) +
    pad(date.getUTCMinutes()) +
    pad(date.getUTCSeconds()) +
    'Z'
  return tagged(0x17, Buffer.from(text, 'ascii'))
}

/** A single-attribute distinguished name: CN=<text>. */
function commonName(text: string): Buffer {
  return sequence(asnSet(sequence(objectIdentifier('2.5.4.3'), utf8String(text))))
}

function extension(oid: string, critical: boolean, value: Buffer): Buffer {
  return critical
    ? sequence(objectIdentifier(oid), asnBoolean(true), octetString(value))
    : sequence(objectIdentifier(oid), octetString(value))
}

/** subjectAltName: DNS:localhost plus IP:127.0.0.1, the two names the server answers on. */
function subjectAltName(): Buffer {
  const dns = (name: string): Buffer => tagged(0x82, Buffer.from(name, 'ascii'))
  const ip = (address: string): Buffer =>
    tagged(0x87, Buffer.from(address.split('.').map((part) => Number.parseInt(part, 10))))
  return extension('2.5.29.17', false, sequence(dns('localhost'), ip('127.0.0.1')))
}

function pem(label: string, der: Buffer): string {
  const body = der
    .toString('base64')
    .replace(/(.{64})/g, '$1\n')
    .trimEnd()
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`
}

function subjectPublicKeyInfo(publicKey: KeyObject): Buffer {
  return publicKey.export({ type: 'spki', format: 'der' })
}

/**
 * Issues a fresh P-256 certificate. ECDSA keeps key generation instant, so the
 * harness can issue one per test run without anybody noticing.
 */
export function selfSignedCertificate(subject = 'nemesis-fixtures'): SelfSignedCertificate {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })

  // ecdsa-with-SHA256 takes no parameters, unlike the RSA identifiers.
  const algorithm = sequence(objectIdentifier('1.2.840.10045.4.3.2'))
  const serial = randomBytes(8)
  serial[0] = (serial[0] ?? 0x01) & 0x7f

  const now = Date.now()
  const name = commonName(subject)
  const tbsCertificate = sequence(
    explicit(0, integer(Buffer.from([0x02]))), // v3
    integer(serial),
    algorithm,
    name,
    sequence(utcTime(new Date(now - 60 * 60 * 1000)), utcTime(new Date(now + 7 * 86400 * 1000))),
    name,
    subjectPublicKeyInfo(publicKey),
    explicit(
      3,
      sequence(
        extension('2.5.29.19', true, sequence(asnBoolean(true))), // basicConstraints: CA
        extension('2.5.29.37', false, sequence(objectIdentifier('1.3.6.1.5.5.7.3.1'))), // EKU: serverAuth
        subjectAltName(),
      ),
    ),
  )

  const signature = sign('sha256', tbsCertificate, privateKey)
  const certificate = sequence(tbsCertificate, algorithm, bitString(signature))

  return {
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    certificate: pem('CERTIFICATE', certificate),
  }
}
