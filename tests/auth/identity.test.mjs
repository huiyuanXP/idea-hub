import test from 'node:test';
import assert from 'node:assert/strict';
import { readCredential,checkRequestOrigin,safeReturnPath } from '../../lib/local-auth.mts';
const token='A'.repeat(43),origin='http://127.0.0.1:5173';
test('identity headers never create a credential and conflicting real transports fail closed',()=>{
 for(const headers of [{},{'x-user-id':'forged'},{'oai-authenticated-user-id':'forged'},{'cf-access-jwt-assertion':token}])assert.equal(readCredential(new Headers(headers)),null);
 assert.deepEqual(readCredential(new Headers({authorization:'Bearer '+token})),{token,transport:'bearer'});
 assert.deepEqual(readCredential(new Headers({cookie:'hub_session='+token})),{token,transport:'cookie'});
 for(const headers of [{authorization:'Basic '+token},{authorization:'Bearer bad'},{authorization:'Bearer '+token,cookie:'hub_session='+token},{cookie:'hub_session='+token+'; hub_session='+token}])assert.throws(()=>readCredential(new Headers(headers)));
});
test('local write policy enforces canonical Host/Origin with programmatic bearer support',()=>{
 for(const [method,transport,headers,allowed] of [
 ['GET','none',{},true],['POST','bearer',{},true],['POST','cookie',{},false],['POST','cookie',{origin},true],['POST','bearer',{origin:'https://foreign.invalid'},false],['GET','bearer',{host:'foreign.invalid'},false],['POST','none',{origin:'null'},false],['POST','bearer',{host:'127.0.0.1:4180'},true],['POST','cookie',{host:'127.0.0.1:4180',origin},false]]){
  const call=()=>checkRequestOrigin(new Headers({host:new URL(origin).host,...headers}),method,origin,transport);
  if(allowed)assert.doesNotThrow(call);else assert.throws(call);
 }
});
test('login return paths remain local and exclude recursive authentication paths',()=>{
 for(const value of [null,'','https://foreign.invalid','//foreign.invalid','/api/auth/logout','/signin','/\\evil','/x\n'])assert.equal(safeReturnPath(value),'/');
 for(const value of ['/','/?view=tickets','/tickets#one'])assert.equal(safeReturnPath(value),value);
});
