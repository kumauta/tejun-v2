const parseButton = document.getElementById("parse-button");
const loadExampleButton = document.getElementById("load-example");
const dslInput = document.getElementById("dsl-input");
const parseError = document.getElementById("parse-error");
const procedureTitle = document.getElementById("procedure-title");
const procedureDescription = document.getElementById("procedure-description");
const stepsContainer = document.getElementById("steps-container");

const stepTemplate = document.getElementById("step-template");
const commandTemplate = document.getElementById("command-template");

const copyHistory = new Map();
const evidenceRecords = new Map();
let activeEvidenceForm = null;

const DEFAULT_DSL = `title: サーバーロールアウト手順
description: stagingサーバーへアプリケーションをデプロイする例です。開始前にアラートを抑止してください。

step: サーバーにログイン
note: 作業アカウントを利用
command: ssh deploy@staging.example.internal

step: アプリケーションを停止
command: sudo systemctl stop example.service

step: リポジトリを更新
command: cd /srv/example
command: git pull --ff-only origin main

step: 多行コマンドの例
command: |
  echo "Checking disk usage"
  df -h /
  du -sh /srv/example

step: アプリケーションを再起動
note: 起動成功を確認したらアラート抑止を解除する
command: sudo systemctl start example.service
command: sudo systemctl status example.service
`;

loadExampleButton.addEventListener("click", () => {
  dslInput.value = DEFAULT_DSL;
  renderProcedureFromSource(DEFAULT_DSL);
});

parseButton.addEventListener("click", () => {
  renderProcedureFromSource(dslInput.value);
});

function renderProcedureFromSource(source) {
  try {
    const procedure = parseDSL(source);
    renderProcedure(procedure);
    parseError.textContent = "";
  } catch (error) {
    parseError.textContent = error.message;
  }
}

function parseDSL(source) {
  const lines = source.replace(/\r\n/g, "\n").split("\n");

  const procedure = {
    title: "手順一覧",
    description: "",
    steps: [],
  };

  let currentStep = null;
  let stepIndex = 0;
  const knownKeywords = new Set(["title", "description", "step", "note", "command"]);

  const finalizeCurrentStep = () => {
    if (!currentStep) {
      return;
    }
    if (currentStep.commands.length === 0) {
      throw new Error(`step "${currentStep.title}" に command が定義されていません。`);
    }
    procedure.steps.push(currentStep);
    currentStep = null;
  };

  let lineIndex = 0;
  while (lineIndex < lines.length) {
    const rawLine = lines[lineIndex];
    const lineNumber = lineIndex;
    const line = rawLine.trim();

    if (line === "" || line.startsWith("//") || line.startsWith("#")) {
      if (line === "") {
        finalizeCurrentStep();
      }
      lineIndex += 1;
      continue;
    }

    const delimiterIndex = line.indexOf(":");
    if (delimiterIndex === -1) {
      throw new Error(`${lineNumber + 1} 行目の構文を解釈できませんでした: "${rawLine}"`);
    }

    const keyword = line.slice(0, delimiterIndex).trim().toLowerCase();
    const value = line.slice(delimiterIndex + 1).trim();

    switch (keyword) {
      case "title":
        procedure.title = value || "無題の手順";
        break;
      case "description":
        procedure.description = value;
        break;
      case "step":
        finalizeCurrentStep();
        if (!value) {
          throw new Error(`${lineNumber + 1} 行目の step にタイトルがありません。`);
        }
        currentStep = {
          id: `step-${stepIndex++}`,
          title: value,
          note: "",
          commands: [],
        };
        break;
      case "note":
        if (!currentStep) {
          throw new Error(`${lineNumber + 1} 行目で note が定義されていますが、直前に step がありません。`);
        }
        currentStep.note = value;
        break;
      case "command":
        if (!currentStep) {
          throw new Error(`${lineNumber + 1} 行目で command が定義されていますが、直前に step がありません。`);
        }
        if (!value) {
          throw new Error(`${lineNumber + 1} 行目の command が空です。`);
        }
        if (value === "|") {
          const blockLines = [];
          let blockIndex = lineIndex + 1;
          while (blockIndex < lines.length) {
            const blockRaw = lines[blockIndex];
            if (blockRaw === "") {
              break;
            }
            const hasIndent = /^[ \t]/.test(blockRaw);
            const blockTrimmed = blockRaw.trim();
            if (!hasIndent) {
              if (blockTrimmed !== "") {
                const possibleDelimiter = blockTrimmed.indexOf(":");
                if (possibleDelimiter !== -1) {
                  const possibleKeyword = blockTrimmed
                    .slice(0, possibleDelimiter)
                    .trim()
                    .toLowerCase();
                  if (knownKeywords.has(possibleKeyword)) {
                    break;
                  }
                }
              }
              break;
            }
            if (blockTrimmed === "") {
              blockLines.push("");
              blockIndex += 1;
              continue;
            }
            blockLines.push(blockRaw.replace(/^[ \t]+/, ""));
            blockIndex += 1;
          }
          if (blockLines.length === 0) {
            throw new Error(`${lineNumber + 1} 行目の command ブロックに内容がありません。`);
          }
          const commandText = blockLines.join("\n");
          const commandId = `${currentStep.id}__cmd_${currentStep.commands.length}`;
          currentStep.commands.push({
            id: commandId,
            text: commandText,
          });
          lineIndex = blockIndex;
          continue;
        }
        const commandId = `${currentStep.id}__cmd_${currentStep.commands.length}`;
        currentStep.commands.push({
          id: commandId,
          text: value,
        });
        break;
      default:
        throw new Error(`${lineNumber + 1} 行目のキーワード "${keyword}" は未対応です。`);
    }
    lineIndex += 1;
  }

  finalizeCurrentStep();

  if (procedure.steps.length === 0) {
    throw new Error("step が1つも定義されていません。");
  }

  return procedure;
}

function renderProcedure(procedure) {
  procedureTitle.textContent = procedure.title || "手順一覧";
  procedureDescription.textContent = procedure.description || "";

  stepsContainer.replaceChildren();

  procedure.steps.forEach((step, index) => {
    const stepElement = buildStepElement(step, index + 1);
    stepsContainer.appendChild(stepElement);
  });
}

function buildStepElement(step, displayIndex) {
  const stepFragment = stepTemplate.content.cloneNode(true);
  const element = stepFragment.querySelector(".step");

  const titleEl = stepFragment.querySelector(".step-title");
  titleEl.textContent = `${displayIndex}. ${step.title}`;

  const notesEl = stepFragment.querySelector(".step-notes");
  if (step.note) {
    notesEl.textContent = step.note;
    notesEl.style.display = "block";
  } else {
    notesEl.textContent = "";
    notesEl.style.display = "none";
  }

  const commandsList = stepFragment.querySelector(".commands");

  step.commands.forEach((command, commandIndex) => {
    const commandFragment = commandTemplate.content.cloneNode(true);
    const listItem = commandFragment.querySelector(".command");
    const commandTextEl = commandFragment.querySelector(".command-text");
    const copyButton = commandFragment.querySelector(".copy-button");
    const historyEl = commandFragment.querySelector(".copy-history");
    const evidenceForm = commandFragment.querySelector(".evidence-form");
    const evidenceInput = commandFragment.querySelector(".evidence-input");
    const evidenceCancel = commandFragment.querySelector(".evidence-cancel");
    const evidenceRecordsEl = commandFragment.querySelector(".evidence-records");

    commandTextEl.textContent = command.text;
    listItem.dataset.commandId = command.id;

    const historyKey = command.id;
    if (!copyHistory.has(historyKey)) {
      copyHistory.set(historyKey, []);
    }
    updateHistory(historyEl, copyHistory.get(historyKey));

    if (!evidenceRecords.has(command.id)) {
      evidenceRecords.set(command.id, []);
    }
    updateEvidenceRecords(evidenceRecordsEl, evidenceRecords.get(command.id));
    hideEvidenceForm(evidenceForm);

    copyButton.addEventListener("click", () =>
      handleCopy(command, copyButton, historyEl, evidenceForm, evidenceInput),
    );

    evidenceForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const value = evidenceInput.value.trim();
      if (!value) {
        evidenceInput.focus();
        return;
      }
      const now = new Date();
      const timestamp = formatTimestamp(now);
      const iso = now.toISOString();
      const records = evidenceRecords.get(command.id) ?? [];
      records.unshift({ timestamp, iso, text: value });
      evidenceRecords.set(command.id, records);
      updateEvidenceRecords(evidenceRecordsEl, records);
      evidenceInput.value = "";
      hideEvidenceForm(evidenceForm);
    });

    evidenceCancel.addEventListener("click", (event) => {
      event.preventDefault();
      hideEvidenceForm(evidenceForm);
    });

    commandsList.appendChild(listItem);
  });

  return element;
}

async function handleCopy(command, button, historyEl, evidenceForm, evidenceInput) {
  try {
    await writeToClipboard(command.text);
    const timestamp = formatTimestamp(new Date());

    const historyList = copyHistory.get(command.id) ?? [];
    historyList.unshift(timestamp);
    copyHistory.set(command.id, historyList);
    updateHistory(historyEl, historyList);
    showEvidenceForm(evidenceForm, evidenceInput);

    const originalLabel = button.textContent;
    button.textContent = "コピー済み";
    button.disabled = true;
    setTimeout(() => {
      button.textContent = originalLabel;
      button.disabled = false;
    }, 1500);
  } catch (error) {
    console.error("Copy failed", error);
    button.textContent = "コピー失敗";
    button.disabled = true;
    setTimeout(() => {
      button.textContent = "コピー";
      button.disabled = false;
    }, 2000);
  }
}

async function writeToClipboard(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "absolute";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  textarea.select();

  try {
    document.execCommand("copy");
  } finally {
    document.body.removeChild(textarea);
  }
}

function updateHistory(historyEl, historyList) {
  historyEl.replaceChildren();
  if (!historyList || historyList.length === 0) {
    return;
  }

  historyList.slice(0, 5).forEach((timestamp) => {
    const badge = document.createElement("span");
    badge.textContent = timestamp;
    historyEl.appendChild(badge);
  });
}

function updateEvidenceRecords(container, records) {
  container.replaceChildren();
  if (!records || records.length === 0) {
    return;
  }

  records.forEach((record) => {
    const card = document.createElement("div");
    card.className = "evidence-record";

    const timeEl = document.createElement("time");
    timeEl.dateTime = record.iso ?? record.timestamp;
    timeEl.textContent = record.timestamp;

    const bodyEl = document.createElement("p");
    bodyEl.className = "evidence-record-text";
    bodyEl.textContent = record.text;

    card.appendChild(timeEl);
    card.appendChild(bodyEl);
    container.appendChild(card);
  });
}

function showEvidenceForm(form, input) {
  if (!form) {
    return;
  }
  if (activeEvidenceForm && activeEvidenceForm !== form) {
    hideEvidenceForm(activeEvidenceForm);
  }
  form.hidden = false;
  if (input) {
    input.value = "";
    input.focus();
  }
  activeEvidenceForm = form;
}

function hideEvidenceForm(form) {
  if (!form) {
    return;
  }
  form.hidden = true;
  if (activeEvidenceForm === form) {
    activeEvidenceForm = null;
  }
}

function formatTimestamp(date) {
  return date.toLocaleString("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

// 初期化
if (!dslInput.value.trim()) {
  dslInput.value = DEFAULT_DSL;
}
renderProcedureFromSource(dslInput.value);
