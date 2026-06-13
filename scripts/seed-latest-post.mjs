// One-off: post the Comment-Reply Window seed comment under the latest Lens FB post.
// Reuses the proven Graph-API write path (FacebookCommentClient). No PG writes.
// Seed copy + classifier are the shared source of truth in src/seed-config.js.
import { FacebookCommentClient } from "../src/comment-responder.js";
import { SEED_COPY, classifyPostType } from "../src/seed-config.js";

function arg(flag){const i=process.argv.indexOf(flag);return i>=0?process.argv[i+1]:undefined;}

async function loadSecrets(){
  const tok=process.env.DOPPLER_TOKEN_EDGE;
  if(!tok) throw new Error("DOPPLER_TOKEN_EDGE not present");
  const auth="Basic "+Buffer.from(`${tok}:`).toString("base64");
  const res=await fetch("https://api.doppler.com/v3/configs/config/secrets?project=ai-and-automation&config=prd",{headers:{Authorization:auth}});
  if(!res.ok) throw new Error(`Doppler fetch failed HTTP ${res.status}`);
  const body=await res.json();
  const s=(n)=>{const e=body.secrets?.[n];if(!e||e.computed==null)throw new Error(`Missing secret ${n}`);return e.computed;};
  return {pageId:s("FACEBOOK_PAGE_ID"), systemUserToken:s("FACEBOOK_SYSTEM_USER_TOKEN")};
}

const secrets=await loadSecrets();
const client=new FacebookCommentClient({pageId:secrets.pageId, systemUserToken:secrets.systemUserToken});
const posts=await client.listRecentPosts({limit:5});
if(!posts.length) throw new Error("No posts returned for page");
const latest=posts[0];
const type=classifyPostType(latest.message);
const out={action:arg("--post")?"post":"inspect", latest_post:{id:latest.id, created_time:latest.created_time, message:(latest.message||"").slice(0,280)}, detected_type:type, seed_to_use:SEED_COPY[type]};

if(process.argv.includes("--post")){
  const seedId=await client.createComment(latest.id, SEED_COPY[type]);
  const readBack=await client.readComment(seedId);
  out.seed_comment_id=seedId;
  out.read_back={id:readBack.id, message:readBack.message, from:readBack.from?.name, created_time:readBack.created_time};
}
console.log(JSON.stringify(out,null,2));
