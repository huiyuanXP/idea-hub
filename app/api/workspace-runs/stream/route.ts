import { canonicalRequest } from '../../../../lib/request-origin';
import { getCurrentUser } from '../../../../lib/current-user';
import { database } from '../../../../lib/local-store.mts';
import { workspaceErrorResponse } from '../../../../lib/workspace-runs/http.mts';
import { streamWorkspaceRun } from '../../../../lib/workspace-runs/live.mts';

export const dynamic='force-dynamic';
export async function GET(request:Request):Promise<Response> {
 try {
  const user=await getCurrentUser(),canonical=canonicalRequest(request);
  // canonicalRequest copies the init but the abort signal must stay bound to the live client connection.
  return streamWorkspaceRun(database(),user?.userId??null,new Request(canonical,{signal:request.signal}));
 }catch(error){return workspaceErrorResponse(error);}
}
