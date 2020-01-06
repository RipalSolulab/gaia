import bitcoin from 'bitcoinjs-lib'
import crypto from 'crypto'
//@ts-ignore
import { decodeToken, TokenSigner, TokenVerifier } from 'jsontokens'
//@ts-ignore
import { ecPairToHexString, ecPairToAddress } from 'aladinjs'
import { ValidationError, AuthTokenTimestampValidationError } from './errors'
import { logger } from './utils'

const DEFAULT_STORAGE_URL = 'storage.aladin.org'
export const LATEST_AUTH_VERSION = 'v1'

function pubkeyHexToECPair (pubkeyHex: string) {
  const pkBuff = Buffer.from(pubkeyHex, 'hex')
  return bitcoin.ECPair.fromPublicKey(pkBuff)
}

export type AuthScopeType = {
  scope: string,
  domain: string
}

export type TokenPayloadType = {
  gaiaChallenge: string,
  iss: string,
  exp: number,
  iat?: number,
  salt: string,
  hubUrl?: string,
  associationToken?: string,
  scopes?: AuthScopeType[],
  childToAssociate?: string
}

export type TokenType = {
  payload: TokenPayloadType
}

export const AuthScopes = [
  'putFile',
  'putFilePrefix',
  'deleteFile',
  'deleteFilePrefix'
]

export class V1Authentication {
  token: string

  constructor(token: string) {
    this.token = token
  }

  static fromAuthPart(authPart: string) {
    if (!authPart.startsWith('v1:')) {
      throw new ValidationError('Authorization header should start with v1:')
    }
    const token = authPart.slice('v1:'.length)
    let decodedToken: TokenType
    try {
      decodedToken = decodeToken(token)
    } catch (e) {
      logger.error(e)
      logger.error('fromAuthPart')
      throw new ValidationError('Failed to decode authentication JWT')
    }
    const publicKey = decodedToken.payload.iss
    if (!publicKey || !decodedToken) {
      throw new ValidationError('Auth token should be a JWT with at least an `iss` claim')
    }
    const scopes = decodedToken.payload.scopes
    if (scopes) {
      validateScopes(scopes)
    }
    return new V1Authentication(token)
  }

  static makeAuthPart(secretKey: bitcoin.ECPair, challengeText: string,
                      associationToken?: string, hubUrl?: string, scopes?: Array<AuthScopeType>,
                      issuedAtDate?: number) {

    const FOUR_MONTH_SECONDS = 60 * 60 * 24 * 31 * 4
    const publicKeyHex = secretKey.publicKey.toString('hex')
    const salt = crypto.randomBytes(16).toString('hex')

    if (scopes) {
      validateScopes(scopes)
    }

    const payloadIssuedAtDate = issuedAtDate || (Date.now()/1000|0)

    const payload: TokenPayloadType = {
      gaiaChallenge: challengeText,
      iss: publicKeyHex,
      exp: FOUR_MONTH_SECONDS + (Date.now() / 1000),
      iat: payloadIssuedAtDate,
      associationToken,
      hubUrl, salt, scopes
    }

    const signerKeyHex = ecPairToHexString(secretKey).slice(0, 64)
    const token = new TokenSigner('ES256K', signerKeyHex).sign(payload)
    return `v1:${token}`
  }

  static makeAssociationToken(secretKey: bitcoin.ECPair, childPublicKey: string) {
    const FOUR_MONTH_SECONDS = 60 * 60 * 24 * 31 * 4
    const publicKeyHex = secretKey.publicKey.toString('hex')
    const salt = crypto.randomBytes(16).toString('hex')
    const payload: TokenPayloadType = {
      childToAssociate: childPublicKey,
      iss: publicKeyHex,
      exp: FOUR_MONTH_SECONDS + (Date.now() / 1000),
      iat: (Date.now() / 1000 | 0),
      gaiaChallenge: String(undefined),
      salt
    }

    const signerKeyHex = ecPairToHexString(secretKey).slice(0, 64)
    const token = new TokenSigner('ES256K', signerKeyHex).sign(payload)
    return token
  }

  checkAssociationToken(token: string, bearerAddress: string) {
    // a JWT can have an `associationToken` that was signed by one of the
    // whitelisted addresses on this server.  This method checks a given
    // associationToken and verifies that it authorizes the "outer"
    // JWT's address (`bearerAddress`)

    let associationToken: TokenType
    try {
      associationToken = decodeToken(token)
    } catch (e) {
      throw new ValidationError('Failed to decode association token in JWT')
    }

    // publicKey (the issuer of the association token)
    // will be the whitelisted address (i.e. the identity address)
    const publicKey = associationToken.payload.iss
    const childPublicKey = associationToken.payload.childToAssociate
    const expiresAt = associationToken.payload.exp

    if (! publicKey) {
      throw new ValidationError('Must provide `iss` claim in association JWT.')
    }

    if (! childPublicKey) {
      throw new ValidationError('Must provide `childToAssociate` claim in association JWT.')
    }

    if (! expiresAt) {
      throw new ValidationError('Must provide `exp` claim in association JWT.')
    }

    const verified = new TokenVerifier('ES256K', publicKey).verify(token)
    if (!verified) {
      throw new ValidationError('Failed to verify association JWT: invalid issuer')
    }

    if (expiresAt < (Date.now()/1000)) {
      throw new ValidationError(
        `Expired association token: expire time of ${expiresAt} (secs since epoch)`)
    }

    // the bearer of the association token must have authorized the bearer
    const childAddress = ecPairToAddress(pubkeyHexToECPair(childPublicKey))
    if (childAddress !== bearerAddress) {
      throw new ValidationError(
        `Association token child key ${childPublicKey} does not match ${bearerAddress}`)
    }

    const signerAddress = ecPairToAddress(pubkeyHexToECPair(publicKey))
    return signerAddress

  }

  /*
   * Get the authentication token's association token's scopes.
   * Does not validate the authentication token or the association token
   * (do that with isAuthenticationValid first).
   *
   * Returns the scopes, if there are any given.
   * Returns [] if there is no association token, or if the association token has no scopes
   */
  getAuthenticationScopes(): Array<AuthScopeType> {
    let decodedToken: TokenType
    try {
      decodedToken = decodeToken(this.token)
    } catch (e) {
      logger.error(this.token)
      logger.error('getAuthenticationScopes')
      throw new ValidationError('Failed to decode authentication JWT')
    }

    if (!decodedToken.payload.hasOwnProperty('scopes')) {
      // not given
      return []
    }

    // unambiguously convert to AuthScope
    const scopes = decodedToken.payload.scopes.map((s) => {
      const r = {
        scope: String(s.scope),
        domain: String(s.domain)
      }
      return r
    })

    return scopes
  }

  /*
   * Determine if the authentication token is valid:
   * * must have signed the given `challengeText`
   * * must not be expired
   * * if it contains an associationToken, then the associationToken must
   *   authorize the given address.
   *
   * Returns the address that signed off on this token, which will be
   * checked against the server's whitelist.
   * * If this token has an associationToken, then the signing address
   *   is the address that signed the associationToken.
   * * Otherwise, the signing address is the given address.
   *
   * this throws a ValidationError if the authentication is invalid
   */
  isAuthenticationValid(address: string, challengeTexts: Array<string>,
                        options?: { requireCorrectHubUrl?: boolean,
                                    validHubUrls?: Array<string>,
                                    oldestValidTokenTimestamp?: number }): string {
    let decodedToken: TokenType
    try {
      decodedToken = decodeToken(this.token)
    } catch (e) {
      logger.error(this.token)
      logger.error('isAuthenticationValid')
      throw new ValidationError('Failed to decode authentication JWT')
    }

    const publicKey = decodedToken.payload.iss
    const gaiaChallenge = decodedToken.payload.gaiaChallenge
    const scopes = decodedToken.payload.scopes

    if (!publicKey) {
      throw new ValidationError('Must provide `iss` claim in JWT.')
    }

    // check for revocations
    if (options && options.oldestValidTokenTimestamp && options.oldestValidTokenTimestamp > 0) {
      const tokenIssuedAtDate = decodedToken.payload.iat
      const oldestValidTokenTimestamp: number = options.oldestValidTokenTimestamp
      if (!tokenIssuedAtDate) {
        const message = `Gaia bucket requires auth token issued after ${oldestValidTokenTimestamp}` +
              ' but this token has no creation timestamp. This token may have been revoked by the user.'
        throw new AuthTokenTimestampValidationError(message, oldestValidTokenTimestamp)
      }
      if (tokenIssuedAtDate < options.oldestValidTokenTimestamp) {
        const message = `Gaia bucket requires auth token issued after ${oldestValidTokenTimestamp}` +
              ` but this token was issued ${tokenIssuedAtDate}.` +
              ' This token may have been revoked by the user.'
        throw new AuthTokenTimestampValidationError(message, oldestValidTokenTimestamp)
      }
    }

    const issuerAddress = ecPairToAddress(pubkeyHexToECPair(publicKey))

    if (issuerAddress !== address) {
      throw new ValidationError('Address not allowed to write on this path')
    }

    if (options && options.requireCorrectHubUrl) {
      let claimedHub = decodedToken.payload.hubUrl
      if (!claimedHub) {
        throw new ValidationError(
          'Authentication must provide a claimed hub. You may need to update aladin.js.')
      }
      if (claimedHub.endsWith('/')) {
        claimedHub = claimedHub.slice(0, -1)
      }
      const validHubUrls = options.validHubUrls
      if (!validHubUrls) {
        throw new ValidationError(
          'Configuration error on the gaia hub. validHubUrls must be supplied.')
      }
      if (validHubUrls.indexOf(claimedHub) < 0) {
        throw new ValidationError(
          `Auth token's claimed hub url '${claimedHub}' not found` +
            ` in this hubs set: ${JSON.stringify(validHubUrls)}`)
      }
    }

    if (scopes) {
      validateScopes(scopes)
    }

    let verified
    try {
      verified = new TokenVerifier('ES256K', publicKey).verify(this.token)
    } catch (err) {
      throw new ValidationError('Failed to verify supplied authentication JWT')
    }

    if (!verified) {
      throw new ValidationError('Failed to verify supplied authentication JWT')
    }

    if (!challengeTexts.includes(gaiaChallenge)) {
      throw new ValidationError(`Invalid gaiaChallenge text in supplied JWT: "${gaiaChallenge}"` +
                                ` not found in ${JSON.stringify(challengeTexts)}`)
    }

    const expiresAt = decodedToken.payload.exp
    if (expiresAt && expiresAt < (Date.now()/1000)) {
      throw new ValidationError(
        `Expired authentication token: expire time of ${expiresAt} (secs since epoch)`)
    }

    if (decodedToken.payload.hasOwnProperty('associationToken') &&
        decodedToken.payload.associationToken) {
      return this.checkAssociationToken(
        decodedToken.payload.associationToken, address)
    } else {
      return address
    }
  }
}

export class LegacyAuthentication {
  publickey: bitcoin.ECPair
  signature: string
  constructor(publickey: bitcoin.ECPair, signature: string) {
    this.publickey = publickey
    this.signature = signature
  }

  static fromAuthPart(authPart: string) {
    const decoded = JSON.parse(Buffer.from(authPart, 'base64').toString())
    const publickey = pubkeyHexToECPair(decoded.publickey)
    const hashType = Buffer.from([bitcoin.Transaction.SIGHASH_NONE])
    const signatureBuffer = Buffer.concat([Buffer.from(decoded.signature, 'hex'), hashType])
    const signature = bitcoin.script.signature.decode(signatureBuffer).signature.toString('hex')
    return new LegacyAuthentication(publickey, signature)
  }

  static makeAuthPart(secretKey: bitcoin.ECPair, challengeText: string) {
    const publickey = secretKey.publicKey.toString('hex')
    const digest = bitcoin.crypto.sha256(Buffer.from(challengeText))
    const signatureBuffer = secretKey.sign(digest)
    const signatureWithHash = bitcoin.script.signature.encode(signatureBuffer, bitcoin.Transaction.SIGHASH_NONE)
    
    // We only want the DER encoding so remove the sighash version byte at the end.
    // See: https://github.com/bitcoinjs/bitcoinjs-lib/issues/1241#issuecomment-428062912
    const signature = signatureWithHash.toString('hex').slice(0, -2)

    const authObj = { publickey, signature }

    return Buffer.from(JSON.stringify(authObj)).toString('base64')
  }

  getAuthenticationScopes(): Array<AuthScopeType> {
    // no scopes supported in this version
    return []
  }

  isAuthenticationValid(address: string, challengeTexts: Array<string>,
                        options? : {}) { //  eslint-disable-line @typescript-eslint/no-unused-vars
    if (ecPairToAddress(this.publickey) !== address) {
      throw new ValidationError('Address not allowed to write on this path')
    }

    for (const challengeText of challengeTexts) {
      const digest = bitcoin.crypto.sha256(Buffer.from(challengeText))
      const valid = (this.publickey.verify(digest, Buffer.from(this.signature, 'hex')) === true)

      if (valid) {
        return address
      }
    }
    logger.debug(`Failed to validate with challenge text: ${JSON.stringify(challengeTexts)}`)
    throw new ValidationError('Invalid signature or expired authentication token.')
  }
}

export function getChallengeText(myURL: string = DEFAULT_STORAGE_URL) {
  const header = 'gaiahub'
  const allowedSpan = '0'
  const myChallenge = 'aladin_storage_please_sign'
  return JSON.stringify( [header, allowedSpan, myURL, myChallenge] )
}

export function getLegacyChallengeTexts(myURL: string = DEFAULT_STORAGE_URL): Array<string> {
  // make legacy challenge texts
  const header = 'gaiahub'
  const myChallenge = 'aladin_storage_please_sign'
  const legacyYears = ['2018', '2019']
  return legacyYears.map(year => JSON.stringify(
    [header, year, myURL, myChallenge]))
}

export function parseAuthHeader(authHeader: string) {
  if (!authHeader || !authHeader.toLowerCase().startsWith('bearer')) {
    throw new ValidationError('Failed to parse authentication header.')
  }
  const authPart = authHeader.slice('bearer '.length)
  const versionIndex = authPart.indexOf(':')
  if (versionIndex < 0) {
    // default to legacy authorization header
    return LegacyAuthentication.fromAuthPart(authPart)
  } else {
    const version = authPart.slice(0, versionIndex)
    if (version === 'v1') {
      return V1Authentication.fromAuthPart(authPart)
    } else {
      throw new ValidationError('Unknown authentication header version: ${version}')
    }
  }
}

export function validateAuthorizationHeader(authHeader: string, serverName: string,
                                            address: string, requireCorrectHubUrl: boolean = false,
                                            validHubUrls: Array<string> = null,
                                            oldestValidTokenTimestamp?: number): string {
  const serverNameHubUrl = `https://${serverName}`
  if (!validHubUrls) {
    validHubUrls = [ serverNameHubUrl ]
  } else if (validHubUrls.indexOf(serverNameHubUrl) < 0) {
    validHubUrls.push(serverNameHubUrl)
  }

  let authObject = null
  try {
    authObject = parseAuthHeader(authHeader)
  } catch (err) {
    logger.error(err)
  }

  if (!authObject) {
    throw new ValidationError('Failed to parse authentication header.')
  }

  const challengeTexts = []
  challengeTexts.push(getChallengeText(serverName))
  getLegacyChallengeTexts(serverName).forEach(challengeText => challengeTexts.push(challengeText))

  return authObject.isAuthenticationValid(address, challengeTexts, { validHubUrls, requireCorrectHubUrl, oldestValidTokenTimestamp })
}


/*
 * Get the authentication scopes from the authorization header.
 * Does not check the authorization header or its association token
 * (do that with validateAuthorizationHeader first).
 *
 * Returns the scopes on success
 * Throws on malformed auth header
 */
export function getAuthenticationScopes(authHeader: string) {
  const authObject = parseAuthHeader(authHeader)
  return authObject.getAuthenticationScopes()
}


/*
 * Validate authentication scopes.  They must be well-formed,
 * and there can't be too many of them.
 * Return true if valid.
 * Throw ValidationError on error
 */
function validateScopes(scopes: Array<AuthScopeType>) {
  if (scopes.length > 8) {
    throw new ValidationError('Too many authentication scopes')
  }

  for (let i = 0; i < scopes.length; i++) {
    const scope = scopes[i]

    // valid scope?
    const found = AuthScopes.find((s) => (s === scope.scope))
    if (!found) {
      throw new ValidationError(`Unrecognized scope ${scope.scope}`)
    }
  }

  return true
}
