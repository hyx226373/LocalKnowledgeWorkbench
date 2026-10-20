export interface RebirthParams { id:string;title:string }
let opener:((p:RebirthParams)=>boolean)|null=null;
export function setRebirthOpener(fn:typeof opener){opener=fn;}
export function openRebirth(p:RebirthParams){return opener?.(p)??false;}
