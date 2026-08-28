import "dotenv/config";
import { Octokit } from "octokit";

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const OWNER = process.env.GITHUB_OWNER;
const REPO = process.env.GITHUB_REPO;

const CHECK_INTERVAL = Number(process.env.CHECK_INTERVAL || 60000);
const TIME_ZONE = process.env.TIME_ZONE || "Asia/Shanghai";

if (!GITHUB_TOKEN) {
  throw new Error("Missing GITHUB_TOKEN");
}

if (!OWNER) {
  throw new Error("Missing GITHUB_OWNER");
}

if (!REPO) {
  throw new Error("Missing GITHUB_REPO");
}

const octokit = new Octokit({
  auth: GITHUB_TOKEN,
});

const processingPRs = new Set();

/**
 * 输出日志
 */
function log(...args) {
  console.log(
    `[${new Date().toLocaleString("zh-CN", {
      timeZone: TIME_ZONE,
      hour12: false,
    })}]`,
    ...args,
  );
}

/**
 * 获取当前北京时间
 */
function getCurrentTime() {
  return new Date();
}

/**
 * 从 PR body 中解析预约时间
 *
 * 支持：
 *
 * 2026-08-28 14:00
 *
 * Schedule date found: "2026-08-28 14:00"
 */
function parseScheduleTime(body) {
  if (!body) {
    return null;
  }

  const patterns = [
    /Schedule date found:\s*"(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})"/i,
    /Schedule date:\s*"(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})"/i,
    /Schedule date:\s*(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})/i,
    /scheduled(?:\s+at|\s+date)?[:：]\s*(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})/i,
    /预约时间[:：]\s*(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})/i,
  ];

  for (const pattern of patterns) {
    const match = body.match(pattern);

    if (match) {
      return match[1];
    }
  }

  // 如果整个 body 里只有一个标准日期，也允许识别
  const fallback = body.match(/\b(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})\b/);

  if (fallback) {
    return fallback[1];
  }

  return null;
}

/**
 * 把 "2026-08-28 14:00"
 * 按 Asia/Shanghai 解析成 Date
 */
function parseBeijingTime(timeString) {
  const match = timeString.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})$/);

  if (!match) {
    return null;
  }

  const [, year, month, day, hour, minute] = match;

  /**
   * Asia/Shanghai 在这里固定使用 UTC+8。
   *
   * 例如：
   *
   * 2026-08-28 14:00
   *
   * => UTC
   *
   * 2026-08-28 06:00
   */
  return new Date(
    Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour) - 8,
      Number(minute),
    ),
  );
}

/**
 * 获取仓库所有 Open PR
 */
async function getOpenPullRequests() {
  const pullRequests = [];

  let page = 1;

  while (true) {
    const response = await octokit.rest.pulls.list({
      owner: OWNER,
      repo: REPO,
      state: "open",
      per_page: 100,
      page,
    });

    if (response.data.length === 0) {
      break;
    }

    pullRequests.push(...response.data);

    if (response.data.length < 100) {
      break;
    }

    page++;
  }

  return pullRequests;
}

/**
 * 获取 PR checks
 */
async function getCheckRuns(ref) {
  const response = await octokit.rest.checks.listForRef({
    owner: OWNER,
    repo: REPO,
    ref,
    per_page: 100,
  });

  return response.data.check_runs;
}

/**
 * 获取 Commit Status
 */
async function getCommitStatuses(ref) {
  const response = await octokit.rest.repos.getCombinedStatusForRef({
    owner: OWNER,
    repo: REPO,
    ref,
  });

  return response.data;
}

/**
 * 判断 CI 是否全部成功
 *
 * 规则：
 *
 * 1. 如果存在 check，必须全部 completed
 * 2. conclusion 必须 success / neutral / skipped
 * 3. commit status 必须 success
 *
 * 没有任何 CI：
 *
 * 允许继续。
 */
async function checkCI(pr) {
  const sha = pr.head.sha;

  const [checkRuns, combinedStatus] = await Promise.all([
    getCheckRuns(sha),
    getCommitStatuses(sha),
  ]);

  /**
   * Checks
   */
  const pendingChecks = checkRuns.filter(
    (check) => check.status !== "completed",
  );

  if (pendingChecks.length > 0) {
    log(
      `PR #${pr.number} CI pending:`,
      pendingChecks.map((check) => check.name).join(", "),
    );

    return false;
  }

  const failedChecks = checkRuns.filter((check) => {
    return !["success", "neutral", "skipped"].includes(check.conclusion);
  });

  if (failedChecks.length > 0) {
    log(
      `PR #${pr.number} failed checks:`,
      failedChecks
        .map((check) => `${check.name}=${check.conclusion}`)
        .join(", "),
    );

    return false;
  }

  /**
   * Commit Status
   */
  const failedStatuses = combinedStatus.statuses.filter(
    (status) => status.state !== "success",
  );

  if (failedStatuses.length > 0) {
    log(
      `PR #${pr.number} failed statuses:`,
      failedStatuses
        .map((status) => `${status.context}=${status.state}`)
        .join(", "),
    );

    return false;
  }

  log(`PR #${pr.number} CI check passed`);

  return true;
}

/**
 * Merge PR
 */
async function mergePullRequest(pr) {
  log(`Trying to merge PR #${pr.number}`);

  try {
    const response = await octokit.rest.pulls.merge({
      owner: OWNER,
      repo: REPO,
      pull_number: pr.number,
      merge_method: "merge",
    });

    if (response.data.merged) {
      log(`SUCCESS: PR #${pr.number} merged successfully`);

      return true;
    }

    log(`FAILED: PR #${pr.number} was not merged`, response.data.message);

    return false;
  } catch (error) {
    log(
      `ERROR: PR #${pr.number} merge failed`,
      error.response?.data || error.message,
    );

    return false;
  }
}

/**
 * 检查单个 PR
 */
async function processPullRequest(pr) {
  if (processingPRs.has(pr.number)) {
    return;
  }

  processingPRs.add(pr.number);

  try {
    log(`Checking PR #${pr.number}: ${pr.title}`);

    const scheduleString = parseScheduleTime(pr.body);

    /**
     * 没有预约时间
     */
    if (!scheduleString) {
      log(`PR #${pr.number} has no schedule time`);

      return;
    }

    log(`PR #${pr.number} scheduled time: ${scheduleString} (${TIME_ZONE})`);

    const scheduledAt = parseBeijingTime(scheduleString);

    if (!scheduledAt) {
      log(`PR #${pr.number} invalid schedule time`);

      return;
    }

    const now = getCurrentTime();

    /**
     * 还没到预约时间
     */
    if (now < scheduledAt) {
      const diff = scheduledAt.getTime() - now.getTime();

      log(
        `PR #${pr.number} not ready yet. Remaining: ${Math.ceil(
          diff / 1000,
        )} seconds`,
      );

      return;
    }

    /**
     * 已经到时间
     */
    log(`PR #${pr.number} schedule time reached`);

    /**
     * 再次确认 PR 状态
     */
    const latestPR = await octokit.rest.pulls.get({
      owner: OWNER,
      repo: REPO,
      pull_number: pr.number,
    });

    const currentPR = latestPR.data;

    if (currentPR.state !== "open") {
      log(`PR #${pr.number} is not open anymore`);

      return;
    }

    /**
     * 如果 PR 已经设置成 draft，不处理
     */
    if (currentPR.draft) {
      log(`PR #${pr.number} is draft`);

      return;
    }

    /**
     * 检查 CI
     */
    const ciPassed = await checkCI(currentPR);

    if (!ciPassed) {
      log(`PR #${pr.number} will not be merged because CI is not ready`);

      return;
    }

    /**
     * 最终 Merge
     */
    await mergePullRequest(currentPR);
  } catch (error) {
    log(`Unexpected error processing PR #${pr.number}:`, error);
  } finally {
    processingPRs.delete(pr.number);
  }
}

/**
 * 主检查函数
 */
async function checkAllPullRequests() {
  log("========================================");
  log("Starting scheduled PR check");

  try {
    const pullRequests = await getOpenPullRequests();

    log(`Found ${pullRequests.length} open PR(s)`);

    for (const pr of pullRequests) {
      await processPullRequest(pr);
    }
  } catch (error) {
    log(
      "Failed to check pull requests:",
      error.response?.data || error.message,
    );
  }

  log("Finished scheduled PR check");
  log("========================================");
}

/**
 * 启动
 */
log("GitHub PR Merge Scheduler started");
log(`Repository: ${OWNER}/${REPO}`);
log(`Check interval: ${CHECK_INTERVAL} ms`);
log(`Time zone: ${TIME_ZONE}`);

/**
 * 启动时立即执行
 */
await checkAllPullRequests();

/**
 * 每分钟执行
 */
setInterval(checkAllPullRequests, CHECK_INTERVAL);
