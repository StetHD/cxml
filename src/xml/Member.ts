// This file is part of cxml, copyright (c) 2015-2016 BusFaster Ltd.
// Released under the MIT license, see LICENSE.

import {Namespace} from './Namespace';
import {Type, TypeSpec} from './Type';

/** Tuple: name, type ID list, flags, substituted member ID */
export type RawMemberSpec = [ string, number[], number, number ];

export class MemberSpec {
	constructor(spec: RawMemberSpec, namespace: Namespace) {
		this.namespace = namespace;
		this.name = spec[0];
		this.substitutesNum = spec[3];
		var typeNumList = spec[1];
		var flags = spec[2];

		this.isAbstract = !!(flags & MemberSpec.abstractFlag);
		this.isSubstituted = !!(flags & MemberSpec.substitutedFlag);

		if(typeNumList.length == 1) {
			this.typeNum = typeNumList[0];
		} else {
			// TODO: What now? Make sure this is not reached.
			// Different types shouldn't be joined with | in .d.ts, instead
			// they should be converted to { TypeA: TypeA, TypeB: TypeB... }

			console.log(spec);
		}
	}

	setSubstitutes(spec: MemberSpec) {
		this.substitutes = spec;

		if(spec.defined) {
			// Entire namespace for substituted member is already fully defined,
			// so the substituted member's dependentList won't get processed any more
			// and we should process this member immediately.

			this.defineMember();
		} else if(spec != this) spec.dependentList.push(this);
	}

	defineMember() {
		if(!this.defined) {
			this.defined = true;

			// Look up member type if available.
			// Sometimes abstract elements have no type.

			if(this.typeNum) {
				this.typeSpec = this.namespace.typeByNum(this.typeNum);
				this.type = this.typeSpec.getType();
			}
		}
	}

	name: string;
	namespace: Namespace;
	substitutesNum: number;
	substitutes: MemberSpec;

	typeNum: number;
	typeSpec: TypeSpec;
	type: Type;

	isAbstract: boolean;
	isSubstituted: boolean;

	// Track dependents for Kahn's topological sort algorithm.
	dependentList: MemberSpec[] = [];

	defined: boolean;

	static abstractFlag = 1;
	static substitutedFlag = 2;
	static anyFlag = 4;
}
