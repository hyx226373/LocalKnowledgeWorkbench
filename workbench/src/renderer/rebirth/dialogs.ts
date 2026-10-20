import { dialogs } from '../ui/dialogs';
export async function askName(title:string,value=''):Promise<string|null>{const answer=await dialogs.prompt({title,fields:[{name:'value',label:title,value}]});return answer?.value.trim()||null;}
export function confirmTrash(body:string){return dialogs.confirm({title:'移入回收站',body,ok:'移入回收站',danger:true});}
