import * as stream from 'stream';

import { ArrayType, encodeArray, decodeArray, concatArray } from '../Buffer';
import { Namespace } from '../Namespace';
import { CodeType } from '../tokenizer/CodeType';
import { ErrorType } from '../tokenizer/ErrorType';
import { NativeParser } from './ParserLib';
import { ParserConfig } from './ParserConfig';
import { ParserNamespace } from './ParserNamespace';
import { InternalToken } from './InternalToken';
import { TokenSet } from '../tokenizer/TokenSet';
import { TokenChunk } from './TokenChunk';
import {
	Token,
	TokenBuffer,
	TokenKind,
	SpecialToken,
	MemberToken,
	OpenToken,
	CloseToken,
	StringToken
} from './Token';

// const codeBufferSize = 2;
// const codeBufferSize = 3;
const codeBufferSize = 8192;

const chunkSize = Infinity;

const enum TOKEN {
	SHIFT = 5,
	MASK = 31
}

export class ParseError extends Error {

	constructor(public code: ErrorType, public row: number, public col: number) {
		super('Parse error on line ' + row + ' column ' + col);
	}

}

/** XML parser stream, emits tokens with fully qualified names. */

export class Parser extends stream.Transform {

	/** Call only from ParserConfig.createParser.
	  * @param config Reference to C++ config object.
	  * @param native Reference to C++ parser object. */
	constructor(private config: ParserConfig, private native: NativeParser) {
		super({ objectMode: true });

		this.codeBuffer = new Uint32Array(codeBufferSize);
		this.native.setCodeBuffer(this.codeBuffer, () => this.parseCodeBuffer(true));

		for(let ns of this.config.namespaceList) {
			if(ns && (ns.base.isSpecial || ns.base.defaultPrefix == 'xml')) {
				this.namespaceList[ns.base.id] = ns.base;
			}
		}
	}

	public parseSync(data: string | ArrayType) {
		const buffer: TokenBuffer = [];
		let namespaceList: (Namespace | undefined)[] | undefined;

		this.on('data', (chunk: TokenChunk) => {
			for(let token of chunk.buffer) buffer.push(token);
			if(chunk.namespaceList) namespaceList = chunk.namespaceList;

			chunk.free();
		});
		this.on('error', (err: any) => { throw(err); });
		this.write(data);

		const output = TokenChunk.allocate(buffer);
		output.namespaceList = namespaceList;

		return(output);
	}

	public getConfig() { return(this.config); }

	bindPrefix(prefix: InternalToken, uri: InternalToken) {
		this.native.bindPrefix(prefix.id, uri.id);
	}

	private throwError(msg: ErrorType, row: number, col: number) {
		const err = new ParseError(msg, row + 1, col + 1);
		this.emit('error', err);
		this.hasError = true;
	}

	_flush( flush: (err: any, chunk: TokenChunk | null) => void) {
		this.native.destroy();
		flush(null, null);
	}

	_transform(
		chunk: string | ArrayType,
		enc: string,
		flush: (err: any, chunk: TokenChunk | null) => void
	) {
		if(this.hasError) return;
		if(typeof(chunk) == 'string') chunk = encodeArray(chunk);

		const len = chunk.length;
		let nativeStatus = ErrorType.OK;
		let next: number;

		if(len < chunkSize) {
			this.chunk = chunk;
			nativeStatus = this.native.parse(this.chunk);
			this.parseCodeBuffer(false);
		} else {
			// Limit size of buffers sent to native code.
			for(let pos = 0; pos < len; pos = next) {
				next = Math.min(pos + chunkSize, len);

				this.chunk = chunk.slice(pos, next);
				nativeStatus = this.native.parse(this.chunk);

				if(nativeStatus != ErrorType.OK) break;
				this.parseCodeBuffer(false);
			}
		}

		if(nativeStatus != ErrorType.OK) {
			this.throwError(nativeStatus, this.native.row, this.native.col);
			return;
		}

		if(this.elementStart < 0) {
			if(this.namespacesChanged) this.tokenChunk.namespaceList = this.namespaceList;
			flush(null, this.tokenChunk);

			this.tokenChunk = TokenChunk.allocate();
		} else {
			// Not ready to flush but have to send something to get more input.
			flush(null, null);
		}
	}

	private parseCodeBuffer(pending: boolean) {
		const config = this.config;
		const codeBuffer = this.codeBuffer;
		const codeCount = codeBuffer[0];

		// NOTE: These must be updated if config is unlinked!
		let elementList = config.elementSpace.list;
		let attributeList = config.attributeSpace.list;
		let prefixList = config.prefixSpace.list;
		let uriList = config.uriSpace.list;
		let partialList = elementList;

		let codeNum = 0;
		let partStart = this.partStart;
		let partialLen = this.partialLen;
		let latestElement = this.latestElement;
		let latestPrefix = this.latestPrefix;
		let latestNamespace = this.latestNamespace;

		const tokenBuffer = this.tokenChunk.buffer;
		const prefixBuffer = this.prefixBuffer;
		const namespaceBuffer = this.namespaceBuffer;
		const unknownElementTbl = this.unknownElementTbl;
		const unknownAttributeTbl = this.unknownAttributeTbl;
		const unknownOffsetList = this.unknownOffsetList;
		let tokenNum = this.tokenChunk.length - 1;
		let token: Token;
		let linkTbl: Token[];
		let linkKind: number;
		let name: string;
		let elementStart = this.elementStart;
		let unknownCount = this.unknownCount;

		while(codeNum < codeCount) {
			let code = codeBuffer[++codeNum];
			const kind = code & TOKEN.MASK;
			code >>= TOKEN.SHIFT;

			switch(kind) {
				case CodeType.OPEN_ELEMENT_ID:

					latestElement = elementList[code].open;
					// TODO: If latestprefix is null, use current prefix for element's namespace.
					tokenBuffer[++tokenNum] = latestElement;
					prefixBuffer[0] = latestPrefix;
					elementStart = tokenNum;
					break;

				case CodeType.CLOSE_ELEMENT_ID:

					tokenBuffer[++tokenNum] = elementList[code].close;
					break;

				case CodeType.ELEMENT_EMITTED:
				case CodeType.CLOSED_ELEMENT_EMITTED:

					if(unknownCount) {
						let ns: ParserNamespace;
						let offset: number;

						for(let pos = 0; pos < unknownCount; ++pos) {
							offset = unknownOffsetList[pos];
							ns = namespaceBuffer[offset]!;
							// If an xmlns definition already resolved
							// this token, ns will be null.
							if(ns) {
								// Ensure namespace is updated after config unlink.
								ns = config.namespaceList[ns.id];
								tokenBuffer[offset + elementStart] = (
									tokenBuffer[offset + elementStart] as MemberToken
								).resolve(ns);
							}
						}

						latestElement = tokenBuffer[elementStart] as OpenToken;
						unknownCount = 0;
					}

					tokenBuffer[++tokenNum] = (
						kind == CodeType.ELEMENT_EMITTED ?
						latestElement.emitted :
						latestElement.close
					)

					elementStart = -1;

					break;

				case CodeType.ATTRIBUTE_ID:

					tokenBuffer[++tokenNum] = attributeList[code].string;
					// If latestprefix is null, set attribute prefix to match its parent element.
					prefixBuffer[tokenNum - elementStart] = latestPrefix || prefixBuffer[0];
					break;

				case CodeType.PREFIX_ID:

					latestNamespace = config.namespaceList[code >> 14];
					code = code & 0x3fff;

				// Fallthru
				case CodeType.XMLNS_ID:

					latestPrefix = prefixList[code];
					break;

				case CodeType.NAMESPACE_ID:

					this.resolve(elementStart, tokenNum, latestPrefix!, code);
					latestPrefix = null;
					break;

				case CodeType.TEXT_START_OFFSET:
				case CodeType.VALUE_START_OFFSET:
				case CodeType.COMMENT_START_OFFSET:
				case CodeType.UNKNOWN_START_OFFSET:

					partStart = code;
					break;

				case CodeType.UNKNOWN_OPEN_ELEMENT_END_OFFSET:

					name = this.getSlice(partStart, code);
					latestElement = unknownElementTbl[name];

					if(!latestElement) {
						latestElement = new OpenToken(name, Namespace.unknown);
						unknownElementTbl[name] = latestElement;
					}

					tokenBuffer[++tokenNum] = latestElement;
					prefixBuffer[0] = latestPrefix;
					namespaceBuffer[0] = latestNamespace;
					elementStart = tokenNum;
					unknownOffsetList[0] = 0;
					unknownCount = 1;

					partStart = -1;
					break;

				case CodeType.UNKNOWN_CLOSE_ELEMENT_END_OFFSET:

					name = this.getSlice(partStart, code);
					tokenBuffer[++tokenNum] = (latestNamespace ?
						latestNamespace.addElement(name) :
						unknownElementTbl[name]
					).close;

					partStart = -1;
					break;

				case CodeType.UNKNOWN_ATTRIBUTE_END_OFFSET:

					name = this.getSlice(partStart, code);
					token = unknownAttributeTbl[name];

					if(!token) {
						token = new StringToken(name, Namespace.unknown);
						unknownAttributeTbl[name] = token;
					}

					tokenBuffer[++tokenNum] = token;

					let pos = tokenNum - elementStart;
					prefixBuffer[pos] = latestPrefix;
					namespaceBuffer[pos] = latestNamespace;
					unknownOffsetList[unknownCount++] = pos;

					partStart = -1;
					break;

				case CodeType.VALUE_END_OFFSET:
				case CodeType.TEXT_END_OFFSET:

					tokenBuffer[++tokenNum] = this.getSlice(partStart, code);
					partStart = -1;
					break;

				case CodeType.UNKNOWN_PREFIX_END_OFFSET:
				case CodeType.UNKNOWN_XMLNS_END_OFFSET:
				case CodeType.UNKNOWN_URI_END_OFFSET:

					// Add the namespace prefix or URI to a separate trie.
					// Incoming code buffer should have been flushed immediately
					// after writing this token.

					if(kind == CodeType.UNKNOWN_URI_END_OFFSET) {
						let uri = this.getSlice(partStart, code);

						/* if(uri.id > dynamicTokenTblSize) {
							// TODO: report row and column in error messages.
							throw(new Error('Too many different xmlns URIs'));
						} */

						// Create a new namespace for the unrecognized URI.
						name = latestPrefix!.name;
						const ns = new Namespace(name, uri, config.maxNamespace + 1);
						// This may unlink the config:
						const idNamespace = config.bindNamespace(ns, latestPrefix!.name, this);
						this.resolve(elementStart, tokenNum, latestPrefix!, idNamespace);
						latestPrefix = null;
					} else {
						// This may unlink the config:
						latestPrefix = config.addPrefix(this.getSlice(partStart, code));

						/* if(latestPrefix.id > dynamicTokenTblSize) {
							// TODO: report row and column in error messages.
							throw(new Error('Too many different xmlns prefixes'));
						} */

						this.native.setPrefix(latestPrefix.id);
					}

					// Config may have been unlinked so update references to it.
					elementList = config.elementSpace.list;
					attributeList = config.attributeSpace.list;
					prefixList = config.prefixSpace.list;
					uriList = config.uriSpace.list;

					partStart = -1;
					break;

				case CodeType.COMMENT_END_OFFSET:

					tokenBuffer[++tokenNum] = SpecialToken.comment;
					tokenBuffer[++tokenNum] = this.getSlice(partStart, code);

					partStart = -1;
					break;

				case CodeType.PARTIAL_LEN:

					partialLen = code;
					break;

				case CodeType.PARTIAL_URI_ID:

					partialList = uriList;

				// Fallthru
				case CodeType.PARTIAL_PREFIX_ID:

					if(partialList == elementList) partialList = prefixList;

				// Fallthru
				case CodeType.PARTIAL_ATTRIBUTE_ID:

					if(partialList == elementList) partialList = attributeList;

				// Fallthru
				case CodeType.PARTIAL_ELEMENT_ID:

					this.partList = [ partialList[code].buf.slice(0, partialLen) ];
					this.partListTotalByteLen = partialLen;

					partialList = elementList;
					break;

				default:

					break;
			}
		}

		if(!pending && partStart >= 0) {
			this.storeSlice(partStart);
			partStart = 0;
		}

		// NOTE: Any active cursor in native code will still use the old trie
		// after update.
		config.updateNamespaces();

		this.partStart = partStart;
		this.partialLen = partialLen;
		this.latestElement = latestElement;
		this.latestPrefix = latestPrefix;
		this.latestNamespace = latestNamespace;

		this.tokenChunk.length = tokenNum + 1;
		this.elementStart = elementStart;
		this.unknownCount = unknownCount;
	}

	private storeSlice(start: number, end?: number) {
		if(!this.partList) this.partList = [];
		if(end !== 0) {
			this.partList.push(this.chunk.slice(start, end));
			this.partListTotalByteLen += (end || this.chunk.length) - start;
		}
	}

	/** getSlice helper for concatenating buffer parts. */
	private buildSlice(start: number, end?: number) {
		this.storeSlice(start, end);

		const result = decodeArray(concatArray(this.partList!, this.partListTotalByteLen));
		this.partList = null;
		this.partListTotalByteLen = 0;

		return(result);
	}

	/** Get a string from the input buffer. Prepend any parts left from
	  * previous code buffers. */
	private getSlice(start: number, end?: number) {
		return((
			this.partList ? this.buildSlice(start, end) :
			decodeArray(this.chunk, start, end)
		).replace(/\r\n?|\n\r/g, '\n'));
	}

	/** Resolve any prior occurrences of a recently defined prefix
	  * within the same element. */
	private resolve(elementStart: number, tokenNum: number, prefix: InternalToken, idNamespace: number) {
		const prefixBuffer = this.prefixBuffer;
		const tokenBuffer = this.tokenChunk.buffer;
		const ns = this.config.namespaceList[idNamespace];
		const len = tokenNum - elementStart;
		let token: Token | number | string;

		if(!ns.base.defaultPrefix) {
			ns.base.defaultPrefix = prefix.name;
		}
		this.namespaceList[ns.base.id] = ns.base;
		this.namespacesChanged = true;

		for(let pos = 0; pos <= len; ++pos) {
			if(prefixBuffer[pos] == prefix) {
				token = tokenBuffer[pos + elementStart];
				if(token instanceof MemberToken) {
					tokenBuffer[pos + elementStart] = token.resolve(ns);
					this.namespaceBuffer[pos] = null;
				}
			}
		}
	}

	/** Current element not yet emitted (closing angle bracket unseen). */
	private latestElement: OpenToken;
	/** Previous namespace prefix token, applied to the next element, attribute
	  * or xmlns definition. */
	private latestPrefix: InternalToken | null;
	private latestNamespace: ParserNamespace | null;

	/** Current input buffer. */
	private chunk: ArrayType;

	private namespaceList: (Namespace | undefined)[] = [];
	private namespacesChanged = true;

	/** Storage for parts of strings split between chunks of input. */
	private partList: ArrayType[] | null = null;
	private partListTotalByteLen = 0;

	/** Offset to start of text in input buffer, or -1 if not reading text. */
	private partStart = -1;

	/** Number of valid initial bytes in next token. */
	private partialLen: number;

	/** Shared with C++ library. */
	private codeBuffer: Uint32Array;
	/** Stream output buffer chunk. */
	tokenChunk = TokenChunk.allocate();

	/** Offset to start of current element definition in output buffer. */
	private elementStart = -1;
	/** Prefixes of latest tokenBuffer entries (their namespace may change
	  * if the prefix is remapped). Index 0 corresponds to elementStart. */
	private prefixBuffer: (InternalToken | null)[] = [];
	private namespaceBuffer: (ParserNamespace | null)[] = [];

	/** Unresolved elements (temporary tokens lacking a namespace). */
	private unknownElementTbl: { [ name: string ]: OpenToken } = {};
	/** Unresolved attributes (temporary tokens lacking a namespace). */
	private unknownAttributeTbl: { [ name: string ]: Token } = {};
	private unknownOffsetList: number[] = [];

	private unknownCount = 0;

	private hasError = false;
}
