// One-off: post the Comment-Reply Window seed comment under the latest Lens FB post.
// Reuses the proven Graph-API write path (FacebookCommentClient). No PG writes.
import { FacebookCommentClient } from "../src/comment-responder.js";

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

const SEEDS={
  tool:"Quick one for the group 👇 What's the one task you'd hand to an AI tool tomorrow if it just worked? Drop it below — we'll dig into the best answers.",
  prompt:"Show us yours 👀 What prompt got you the best result this week? Paste it in the comments — we'll feature the sharpest ones.",
  poll:"No wrong answers here 🙌 Tell us *why* you voted the way you did — the reasoning is where it gets interesting. 👇",
  recap:"Catch anything we missed this week? Drop the AI tool or trick that earned a permanent spot in your workflow 👇",
  generic:"Curious where everyone lands on this 👇 What's your take? One line is plenty — we read every comment.",
};

function classify(msg){
  const m=(msg||"").toLowerCase();
  if(/recap|this week|round ?up|weekly/.test(m)) return "recap";
  if(/prompt/.test(m)) return "prompt";
  if(/poll|this or that|vote|would you rather/.test(m)) return "poll";
  if(/tool|app|try |feature|launch|release/.test(m)) return "tool";
  return "generic";
}

const secrets=await loadSecrets();
const client=new FacebookCommentClient({pageId:secrets.pageId, systemUserToken:secrets.systemUserToken});
const posts=await client.listRecentPosts({limit:5});
if(!posts.length) throw new Error("No posts returned for page");
const latest=posts[0];
const type=classify(latest.message);
const out={action:arg("--post")?"post":"inspect", latest_post:{id:latest.id, created_time:latest.created_time, message:(latest.message||"").slice(0,280)}, detected_type:type, seed_to_use:SEEDS[type]};

if(process.argv.includes("--post")){
  const seedId=await client.createComment(latest.id, SEEDS[type]);
  const readBack=await client.readComment(seedId);
  out.seed_comment_id=seedId;
  out.read_back={id:readBack.id, message:readBack.message, from:readBack.from?.name, created_time:readBack.created_time};
}
console.log(JSON.stringify(out,null,2));
