// Motion Eye Prototype - 眼+头协同跟随
// 2D 模式，确保显示和交互可用

// ============ 可调参数 ============
let params = {
  eps: 0.02,
  alpha_in: 0.2,
  zone_head_min: 0.75,
  head_delay_ms: 1000,  // 眼先动后，延迟多少 ms 再开始转头（1s 便于观察）
  eyeMaxPx: 30,
  eyeGain: 1.0,
  alpha_eye: 0.18,
  headMaxDeg: 30,
  headGain: 1.0,  // 1.0=头转到人脸居中；<1 则只转部分角度
  alpha_head: 0.03,  // 头旋转平滑系数，越小越慢（定位：第 160 行 headYaw 更新）
  E_exit: 0.25,
  lost_frames: 10
};

// ============ 管线状态 ============
const W = 320, H = 240;
let pipeline = {
  cx: W / 2, cy: H / 2,
  nx: 0, nx_prev: 0, nx_s: 0,
  ny: 0, ny_prev: 0, ny_s: 0,
  zone: 'dead',
  eyeTarget: 0, eyeTargetY: 0, headTarget: 0,
  eyeX: 0, eyeY: 0, headYaw: 0,
  lostCount: 0, isLost: false,
  lostPhase: 'none', lostTimer: 0,
  lastEyeX: 0, lastEyeY: 0, lastHeadYaw: 0,
  coordPhase: 'idle',
  head_delay_timer: 0   // 进入头区后累积，超过 head_delay_ms 才开始转头
};

// ============ 配置 ============
const config = {
  eyeSize: 240,
  eyeGap: 160,
  canvasWidth: 720,
  canvasHeight: 400,
  pupilMaxOffset: 30,
  pupilScale: 0.7,  // 瞳孔大小为眼睛的 70%
  highlightFollow: 0.3
};

// ============ 图层（异步加载，不阻塞） ============
let layers = {
  left: { eyeball: null, pupil: null, highlight: null },
  right: { eyeball: null, pupil: null, highlight: null }
};
let canvasCtx = null;

function setup() {
  const cnv = createCanvas(config.canvasWidth, config.canvasHeight);
  cnv.parent('canvas-container');
  canvasCtx = cnv.elt.getContext('2d');
  frameRate(60);
  imageMode(CENTER);

  // 异步加载图片，不阻塞
  loadImage('assets/left_eye/eyeball.png', (img) => { layers.left.eyeball = img; }, () => {});
  loadImage('assets/left_eye/pupil.png', (img) => { layers.left.pupil = img; }, () => {});
  loadImage('assets/left_eye/highlight.png', (img) => { layers.left.highlight = img; }, () => {});
  loadImage('assets/right_eye/eyeball.png', (img) => { layers.right.eyeball = img; }, () => {});
  loadImage('assets/right_eye/pupil.png', (img) => { layers.right.pupil = img; }, () => {});
  loadImage('assets/right_eye/highlight.png', (img) => { layers.right.highlight = img; }, () => {});

  window.setParam = (key, value) => {
    if (params.hasOwnProperty(key)) params[key] = value;
  };
}

// ============ 从 HTML 输入框同步数据 ============
function syncInput() {
  const fi = window.faceInput;
  if (fi) {
    pipeline.cx = fi.cx;
    pipeline.cy = fi.cy;
    if (!fi.active) pipeline.lostCount++;
    else { pipeline.lostCount = 0; pipeline.isLost = false; pipeline.lostPhase = 'none'; }
  }
}

// ============ 管线更新 ============
function updatePipeline() {
  const p = pipeline;
  const pr = params;

  p.nx = (p.cx - W / 2) / (W / 2);
  p.nx = Math.max(-1, Math.min(1, p.nx));
  if (Math.abs(p.nx - p.nx_prev) < pr.eps) p.nx = p.nx_prev;
  p.nx_prev = p.nx;
  p.nx_s = p.nx_s + pr.alpha_in * (p.nx - p.nx_s);

  p.ny = (p.cy - H / 2) / (H / 2);
  p.ny = Math.max(-1, Math.min(1, p.ny));
  if (Math.abs(p.ny - p.ny_prev) < pr.eps) p.ny = p.ny_prev;
  p.ny_prev = p.ny;
  p.ny_s = p.ny_s + pr.alpha_in * (p.ny - p.ny_s);

  if (p.lostCount >= pr.lost_frames) {
    p.isLost = true;
    handleLostState();
    return;
  }

  const abs_nx = Math.abs(p.nx_s);
  const abs_ny = Math.abs(p.ny_s);
  const inDeadZone = abs_nx < 0.12 && abs_ny < 0.12;  // 中心小方块，非竖条
  if (inDeadZone) p.zone = 'dead';
  else if (abs_nx < pr.zone_head_min) p.zone = 'eye';
  else p.zone = 'head';

  if (p.zone === 'dead') {
    p.eyeTarget = 0;
    p.eyeTargetY = 0;
    p.headTarget = 0;
    p.coordPhase = 'idle';
    p.head_delay_timer = 0;
  } else if (p.zone === 'eye') {
    p.eyeTarget = p.nx_s * pr.eyeGain * pr.eyeMaxPx;
    p.eyeTarget = Math.max(-pr.eyeMaxPx, Math.min(pr.eyeMaxPx, p.eyeTarget));
    p.eyeTargetY = p.ny_s * pr.eyeGain * pr.eyeMaxPx;
    p.eyeTargetY = Math.max(-pr.eyeMaxPx, Math.min(pr.eyeMaxPx, p.eyeTargetY));
    p.headTarget = 0;
    p.coordPhase = 'eye_first';
    p.head_delay_timer = 0;
  } else {
    // 头区：眼先到极限 → [延迟 head_delay_ms] → 头转 → 眼归位
    // 延迟逻辑：head_delay_timer 每帧累加 deltaTime(ms)，未达 head_delay_ms 前 headYaw 不更新
    // deltaTime = 上一帧到本帧的间隔(ms)，60fps 时约 16.67
    p.head_delay_timer += (typeof deltaTime !== 'undefined' ? deltaTime : 16.67);
    const headReady = p.head_delay_timer >= pr.head_delay_ms;
    // 头目标：旋转到人脸处于视野中心为止（effective_nx=0 => headYaw = nx_s * headMaxDeg）
    // headGain=1 时完全居中；<1 时只转部分角度
    const headTargetValue = Math.max(-pr.headMaxDeg, Math.min(pr.headMaxDeg, p.nx_s * pr.headGain * pr.headMaxDeg));
    p.headTarget = headReady ? headTargetValue : p.headYaw;  // 延迟期间保持当前头角度
    // 模拟：头转动后，重新检测人脸在旋转后坐标系中的位置
    // effective = 旋转后视野中的目标位置（头转向目标时，目标在视野中更居中）
    const effective_nx = p.nx_s - p.headYaw / pr.headMaxDeg;
    const effective_ny = p.ny_s;  // 水平旋转不影响垂直
    const abs_effective = Math.abs(effective_nx);
    if (abs_effective < pr.E_exit) {
      // 头已到位：眼按旋转后坐标正常速度移动到目标（非快速居中）
      p.eyeTarget = effective_nx * pr.eyeGain * pr.eyeMaxPx;
      p.eyeTarget = Math.max(-pr.eyeMaxPx, Math.min(pr.eyeMaxPx, p.eyeTarget));
      p.eyeTargetY = effective_ny * pr.eyeGain * pr.eyeMaxPx;
      p.eyeTargetY = Math.max(-pr.eyeMaxPx, Math.min(pr.eyeMaxPx, p.eyeTargetY));
      p.coordPhase = 'eye_return';
    } else {
      // 眼保持极限，头在延迟后开始转
      p.eyeTarget = (p.nx_s > 0 ? 1 : -1) * pr.eyeMaxPx;
      p.eyeTargetY = p.ny_s * pr.eyeGain * pr.eyeMaxPx;
      p.eyeTargetY = Math.max(-pr.eyeMaxPx, Math.min(pr.eyeMaxPx, p.eyeTargetY));
      p.coordPhase = headReady ? 'head_turn' : 'eye_first';  // 延迟期间仍为 eye_first
    }
  }

  p.eyeX = p.eyeX + pr.alpha_eye * (p.eyeTarget - p.eyeX);
  p.eyeY = p.eyeY + pr.alpha_eye * (p.eyeTargetY - p.eyeY);
  // 延迟期间跳过 head 更新，确保眼先动、头后动（定位：head_delay_timer 累积，< head_delay_ms 时不更新 headYaw）
  if (!(p.zone === 'head' && p.head_delay_timer < pr.head_delay_ms)) {
    p.headYaw = p.headYaw + pr.alpha_head * (p.headTarget - p.headYaw);
  }
}

function handleLostState() {
  const p = pipeline;
  p.zone = 'lost';
  if (p.lostPhase === 'none') {
    p.lostPhase = 'look_last';
    p.lastEyeX = p.eyeX;
    p.lastEyeY = p.eyeY;
    p.lastHeadYaw = p.headYaw;
    p.lostTimer = 0;
  }
  p.lostTimer += deltaTime;
  if (p.lostPhase === 'look_last') {
    p.eyeX = p.eyeX + 0.08 * (p.lastEyeX - p.eyeX);
    p.eyeY = p.eyeY + 0.08 * (p.lastEyeY - p.eyeY);
    p.headYaw = p.headYaw + 0.03 * (p.lastHeadYaw - p.headYaw);
    if (p.lostTimer > 500) { p.lostPhase = 'pause'; p.lostTimer = 0; }
  } else if (p.lostPhase === 'pause') {
    if (p.lostTimer >= 1000) { p.lostPhase = 'return'; p.lostTimer = 0; }
  } else if (p.lostPhase === 'return') {
    p.eyeX = p.eyeX + 0.05 * (0 - p.eyeX);
    p.eyeY = p.eyeY + 0.05 * (0 - p.eyeY);
    p.headYaw = p.headYaw + 0.02 * (0 - p.headYaw);
    if (Math.abs(p.eyeX) < 1 && Math.abs(p.eyeY) < 1 && Math.abs(p.headYaw) < 1) {
      p.lostPhase = 'none';
      p.eyeX = 0;
      p.eyeY = 0;
      p.headYaw = 0;
    }
  }
}

// ============ 主循环 ============
function draw() {
  background(245, 240, 235);  // 浅灰背景，便于区分

  syncInput();
  if (!pipeline.isLost) {
    if (!window.faceInput || !window.faceInput.active) pipeline.lostCount++;
    updatePipeline();
  } else {
    handleLostState();
  }

  const cx = config.canvasWidth / 2;
  const cy = config.canvasHeight / 2;
  const headOffset = pipeline.headYaw * 4;

  // 1. 头部 + 眼睛（整体随 headYaw 水平偏移）
  push();
  translate(cx + headOffset, cy);
  drawFace();
  drawEyes();
  pop();

  // 2. 身体：圆柱形（圆角矩形），后画以露出在脸部下方
  drawBody(cx, cy, headOffset);

  const el = document.getElementById('status-bar');
  if (el) {
    const p = pipeline;
    el.textContent = `zone: ${p.zone} | nx_s: ${p.nx_s.toFixed(3)} | eyeX: ${p.eyeX.toFixed(1)} | eyeY: ${p.eyeY.toFixed(1)} | headYaw: ${p.headYaw.toFixed(1)}°`;
  }
  const dataEl = document.getElementById('display-data');
  if (dataEl) {
    let phaseLabel = { idle: '—', eye_first: '①眼先动', head_turn: '②头转', eye_return: '③眼归位' }[pipeline.coordPhase] || pipeline.coordPhase;
    if (pipeline.zone === 'head' && pipeline.head_delay_timer < params.head_delay_ms) {
      phaseLabel = `①眼先动(延迟${Math.round(params.head_delay_ms - pipeline.head_delay_timer)}ms)`;
    }
    dataEl.innerHTML = `协同: <b>${phaseLabel}</b> &nbsp;|&nbsp; eyeX: <b>${pipeline.eyeX.toFixed(1)}</b> px &nbsp;|&nbsp; eyeY: <b>${pipeline.eyeY.toFixed(1)}</b> px &nbsp;|&nbsp; headYaw: <b>${pipeline.headYaw.toFixed(1)}</b> °`;
  }
}

// 身体：圆柱形（2D 用圆角矩形表示）
function drawBody(centerX, centerY, headOffset) {
  const bodyW = 180;
  const bodyH = 120;
  const bodyY = centerY + 100;
  push();
  translate(centerX + headOffset * 0.5, bodyY);
  noStroke();
  fill(255, 207, 238);  // #FFCFEE
  rectMode(CENTER);
  rect(0, 0, bodyW, bodyH, 20);
  fill(80);
  textSize(12);
  textAlign(CENTER);
  text('身体', 0, -bodyH / 2 - 8);
  pop();
}

// 脸部椭圆（肉色 = 头部/脸）
function drawFace() {
  noStroke();
  fill(255, 235, 220);
  ellipse(0, 0, 560, 400);
  fill(100);
  textSize(12);
  textAlign(CENTER);
  text('头部', 0, -220);
}

// 眼睛（240×240，两眼间隔 160，瞳孔偏移 ±30）
function drawEyes() {
  const s = config.eyeSize;  // 240
  const leftX = -config.eyeGap / 2 - s / 2;
  const rightX = config.eyeGap / 2 + s / 2;
  drawSingleEye(leftX, 0, 'left');
  drawSingleEye(rightX, 0, 'right');
}

function drawSingleEye(centerX, centerY, side) {
  const s = config.eyeSize;  // 240×240
  const px = pipeline.eyeX;  // 瞳孔偏移，管线已限制 ±30
  const py = pipeline.eyeY;  // 垂直方向同样 ±30
  const layer = layers[side];

  push();
  translate(centerX, centerY);

  // 240×240 圆形遮罩（已 translate 到眼睛中心，圆心 0,0）
  if (canvasCtx) {
    canvasCtx.save();
    canvasCtx.beginPath();
    canvasCtx.arc(0, 0, s / 2, 0, Math.PI * 2);
    canvasCtx.clip();
  }

  if (layer.eyeball) {
    image(layer.eyeball, 0, 0, s, s);
    if (layer.pupil) {
      push();
      translate(px, py);
      const pupilSize = s * config.pupilScale;
      image(layer.pupil, 0, 0, pupilSize, pupilSize);
      pop();
    }
    if (layer.highlight) {
      push();
      translate(px * config.highlightFollow, py * config.highlightFollow);
      image(layer.highlight, 0, 0, s, s);
      pop();
    }
  } else {
    noStroke();
    fill(255);
    ellipse(0, 0, s * 0.85, s * 0.75);
    fill(50, 40, 35);
    const pupilSize = s * config.pupilScale;
    ellipse(px, py, pupilSize, pupilSize);
    fill(255);
    ellipse(px - pupilSize * 0.2, py - pupilSize * 0.2, pupilSize * 0.25, pupilSize * 0.25);
  }

  if (canvasCtx) canvasCtx.restore();
  pop();
}
