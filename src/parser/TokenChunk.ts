import { Namespace } from '../Namespace';
import { Token, TokenBuffer, TokenKind } from './Token';

export class TokenChunk {

	static allocate(buffer: TokenBuffer = []) {
		let chunk = TokenChunk.first;

		if(chunk) {
			TokenChunk.first = chunk.next;
		} else {
			chunk = new TokenChunk();
		}

		chunk.length = buffer.length;
		chunk.buffer = buffer;
		// Clear free list pointer to help GC find garbage also if free() is not called.
		chunk.next = void 0;
		chunk.namespaceList = void 0;

		return(chunk);
	}

	free() {
		this.next = TokenChunk.first;
		TokenChunk.first = this;
	}

	length: number;
	buffer: TokenBuffer;
	next: TokenChunk | undefined;
	namespaceList: (Namespace | undefined)[] | undefined;

	private static first: TokenChunk | undefined;

}
