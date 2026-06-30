/**
 * 阿里云盘每日签到 - 青龙面板脚本
 * 
 * 使用方法：
 *   1. 青龙面板依赖管理添加：axios
 *   2. 青龙面板环境变量添加：
 *      名称：refreshToken      值：你的阿里云盘 refresh_token（支持多个，用 & 或换行分隔）
 *      名称：ALIYUN_PUSH_PLUS 值：PushPlus Token（可选，用于微信推送通知）
 *   3. 获取 refresh_token：
 *      浏览器登录 https://www.aliyundrive.com/ 后，
 *      F12 控制台输入: JSON.parse(localStorage.token).refresh_token
 * 
 * 青龙定时规则建议：0 8 * * * （每天早上8点）
 */

const axios = require('axios');
const https = require('https');

// ====================== 配置 ======================

// 超时时间（毫秒）
const REQUEST_TIMEOUT = 15000;

// 最大重试次数
const MAX_RETRIES = 3;

// 重试间隔基数（毫秒），实际间隔为 base + random(0, 5000)
const RETRY_BASE_DELAY = 2000;

// User-Agent 列表（随机选取，降低检测风险）
const UA_LIST = [
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Linux; Android 13; SM-S9080) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.5845.163 Mobile Safari/537.36',
];

// ====================== 工具函数 ======================

/** 获取随机 UA */
function randomUA() {
  return UA_LIST[Math.floor(Math.random() * UA_LIST.length)];
}

/** 创建 HTTP 客户端 */
function createClient() {
  return axios.create({
    timeout: REQUEST_TIMEOUT,
    httpsAgent: new https.Agent({ rejectUnauthorized: false }),
    headers: {
      'User-Agent': randomUA(),
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
  });
}

/** 延迟函数 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** 带重试的 POST 请求 */
async function postWithRetry(url, data, headers = {}, params = {}) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const client = createClient();
      const response = await client.post(url, data, {
        headers: { ...client.defaults.headers, ...headers },
        params,
      });
      return response.data;
    } catch (error) {
      lastError = error;
      const status = error.response?.status;
      const msg = error.response?.data?.message || error.message;
      console.log(`  ⚠️  请求失败 (第${attempt}次): [${status}] ${msg}`);
      if (attempt < MAX_RETRIES) {
        const delay = RETRY_BASE_DELAY + Math.floor(Math.random() * 5000);
        console.log(`  ⏳ 等待 ${Math.round(delay / 1000)}s 后重试...`);
        await sleep(delay);
      }
    }
  }
  throw lastError;
}

/** 从环境变量获取 refreshToken 列表 */
function getRefreshTokens() {
  const raw = process.env.refreshToken || '';
  if (!raw.trim()) {
    console.log('❌ 未找到环境变量 refreshToken，请在青龙面板中添加');
    return [];
  }
  // 支持 & 或换行分隔
  return raw
    .split(/[&\n\r]+/)
    .map(t => t.trim())
    .filter(t => t.length > 10);
}

// ====================== 签到核心逻辑 ======================

/**
 * 第一步：用 refresh_token 换取 access_token
 */
async function getAccessToken(refreshToken) {
  const url = 'https://auth.aliyundrive.com/v2/account/token';
  const payload = {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  };

  const data = await postWithRetry(url, payload);

  if (data.code) {
    const errMsg = data.message || JSON.stringify(data);
    throw new Error(`获取 access_token 失败: ${errMsg}`);
  }

  const nickName = data.nick_name || '';
  const userName = data.user_name || '';
  const name = nickName || userName;
  const accessToken = data.access_token;

  return { name, accessToken };
}

/**
 * 第二步：执行签到
 */
async function doSignIn(accessToken) {
  const url = 'https://member.aliyundrive.com/v1/activity/sign_in_list';
  const payload = { isReward: false };
  const params = { '_rx-s': 'mobile' };
  const headers = { Authorization: `Bearer ${accessToken}` };

  const data = await postWithRetry(url, payload, headers, params);

  if (!data.success) {
    const errMsg = data.message || '签到失败（今日可能已签到）';
    throw new Error(errMsg);
  }

  const signInCount = data.result?.signInCount || 0;
  return signInCount;
}

/**
 * 第三步：领取当日奖励（可能已领过）
 */
async function claimReward(accessToken, signInDay) {
  const url = 'https://member.aliyundrive.com/v1/activity/sign_in_reward';
  const payload = { signInDay };
  const params = { '_rx-s': 'mobile' };
  const headers = { Authorization: `Bearer ${accessToken}` };

  const data = await postWithRetry(url, payload, headers, params);

  if (data.success) {
    const notice = data.result?.notice || '';
    return { claimed: true, notice };
  }
  // 已领取过也视为正常
  if (data.message && data.message.includes('已领取')) {
    return { claimed: false, notice: '奖励已领取过' };
  }
  return { claimed: false, notice: data.message || '领取失败' };
}

/**
 * 第四步：获取签到列表（含奖励信息）
 */
async function getSignInList(accessToken) {
  const url = 'https://member.aliyundrive.com/v2/activity/sign_in_list';
  const payload = {};
  const params = { '_rx-s': 'mobile' };
  const headers = { Authorization: `Bearer ${accessToken}` };

  const data = await postWithRetry(url, payload, headers, params);

  if (!data.success) {
    throw new Error(data.message || '获取签到列表失败');
  }

  const result = data.result || {};
  return {
    signInCount: result.signInCount || 0,
    signInInfos: result.signInInfos || [],
    signInLogs: result.signInLogs || [],
  };
}

// ====================== PushPlus 推送 ======================

async function pushNotify(title, content) {
  const pushPlusToken = process.env.ALIYUN_PUSH_PLUS || '';
  if (!pushPlusToken) return;

  try {
    const client = createClient();
    await client.post('http://www.pushplus.plus/send', {
      token: pushPlusToken,
      title,
      content,
      template: 'html',
    });
    console.log('  📤 PushPlus 推送成功');
  } catch (e) {
    console.log(`  ⚠️  PushPlus 推送失败: ${e.message}`);
  }
}

// ====================== 主流程 ======================

async function checkInOne(refreshToken, index, total) {
  const prefix = total > 1 ? `[${index + 1}/${total}] ` : '';
  console.log(`\n${'='.repeat(50)}`);
  console.log(`${prefix}⚡ 开始签到...`);
  console.log(`${'='.repeat(50)}`);

  const result = {
    success: false,
    name: '',
    signInCount: 0,
    reward: '',
    rewardNotice: '',
    error: '',
  };

  try {
    // Step 1: 获取 access_token
    console.log('📡 获取 access_token...');
    const { name, accessToken } = await getAccessToken(refreshToken);
    result.name = name;
    console.log(`  ✅ 用户: ${name}`);

    // Step 2: 执行签到
    console.log('📝 执行签到...');
    const signInCount = await doSignIn(accessToken);
    result.signInCount = signInCount;
    console.log(`  ✅ 签到成功！本月累计签到 ${signInCount} 天`);

    // Step 3: 领取奖励
    console.log('🎁 领取奖励...');
    const reward = await claimReward(accessToken, signInCount);
    if (reward.claimed) {
      result.rewardNotice = reward.notice;
      console.log(`  ✅ 奖励: ${reward.notice}`);
    } else {
      console.log(`  ℹ️  ${reward.notice}`);
    }
    result.reward = reward.notice;

    // Step 4: 获取详细列表
    console.log('📊 获取签到详情...');
    const list = await getSignInList(accessToken);

    // 打印签到日历
    const logs = list.signInLogs || [];
    const signedDays = new Set(logs.map(l => l.day));
    const currentDay = new Date().getDate();
    let calendar = '  📅 本月签到: ';
    for (let d = 1; d <= 31 && d <= currentDay; d++) {
      calendar += signedDays.has(d) ? '✅' : '⬜';
      if (d % 7 === 0 && d < currentDay) calendar += ' ';
    }
    console.log(calendar);

    // 当月奖励概览
    const infos = list.signInInfos || [];
    const todayInfo = infos.find(i => i.day === signInCount && i.signed);
    if (todayInfo && todayInfo.rewards && todayInfo.rewards.length > 0) {
      todayInfo.rewards.forEach(r => {
        const typeMap = {
          dailySignIn: '📌 签到奖励',
          dailyTask: '📋 任务奖励',
        };
        const label = typeMap[r.type] || r.type;
        console.log(`  ${label}: ${r.name} - ${r.remind || ''}`);
      });
    }

    result.success = true;
  } catch (error) {
    const errMsg = error.message || String(error);
    result.error = errMsg;
    console.log(`  ❌ ${errMsg}`);
  }

  return result;
}

async function main() {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║      阿里云盘每日签到 - 青龙面板       ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log(`⏰ 运行时间: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`);

  const tokens = getRefreshTokens();
  if (tokens.length === 0) {
    console.log('\n❌ 没有配置 refreshToken，请先在青龙面板添加环境变量');
    console.log('   名称: refreshToken');
    console.log('   值: 你的阿里云盘 refresh_token');
    return;
  }

  console.log(`\n🔑 检测到 ${tokens.length} 个账号\n`);

  const results = [];
  for (let i = 0; i < tokens.length; i++) {
    // 多账号间随机延迟 1-5 秒
    if (i > 0) {
      const delay = 1000 + Math.floor(Math.random() * 4000);
      console.log(`\n⏳ 等待 ${Math.round(delay / 1000)}s 后处理下一个账号...`);
      await sleep(delay);
    }
    const result = await checkInOne(tokens[i], i, tokens.length);
    results.push(result);
  }

  // 汇总
  console.log(`\n${'='.repeat(50)}`);
  console.log('📋 签到汇总');
  console.log(`${'='.repeat(50)}`);

  let pushContent = '';
  for (const r of results) {
    const status = r.success ? '✅' : '❌';
    const line = `${status} ${r.name || '(未知)'} | 签到${r.signInCount}天`;
    console.log(`  ${line}`);
    pushContent += `${line}<br/>`;
    if (r.rewardNotice) {
      console.log(`    🎁 ${r.rewardNotice}`);
      pushContent += `&nbsp;&nbsp;&nbsp;&nbsp;🎁 ${r.rewardNotice}<br/>`;
    }
    if (r.error) {
      console.log(`    ❌ ${r.error}`);
      pushContent += `&nbsp;&nbsp;&nbsp;&nbsp;❌ ${r.error}<br/>`;
    }
  }

  // PushPlus 推送
  if (process.env.ALIYUN_PUSH_PLUS) {
    await pushNotify('阿里云盘签到通知', pushContent);
  }

  // 检查是否有失败的
  const failed = results.filter(r => !r.success);
  if (failed.length > 0) {
    console.log(`\n⚠️  ${failed.length} 个账号签到失败，请检查 refresh_token 是否过期`);
  }

  console.log('\n✨ 全部完成！');
}

main().catch(err => {
  console.error('💥 脚本异常:', err.message);
  process.exit(1);
});
