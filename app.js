const parseButton = document.getElementById("parse-button");
const loadExampleButton = document.getElementById("load-example");
const dslInput = document.getElementById("dsl-input");
const parseError = document.getElementById("parse-error");
const procedureTitle = document.getElementById("procedure-title");
const procedureDescription = document.getElementById("procedure-description");
const stepsContainer = document.getElementById("steps-container");
const exportButton = document.getElementById("export-button");
const exportModal = document.getElementById("export-modal");
const exportOutput = document.getElementById("export-output");
const exportCopyButton = document.getElementById("export-copy-button");
const exportCloseButton = document.getElementById("export-close-button");

const stepTemplate = document.getElementById("step-template");
const commandTemplate = document.getElementById("command-template");

const copyHistory = new Map();
const evidenceRecords = new Map();
let activeEvidenceForm = null;
let currentProcedure = null;
let lastExportMarkdown = "";

if (exportCopyButton && !exportCopyButton.dataset.defaultLabel) {
  exportCopyButton.dataset.defaultLabel = exportCopyButton.textContent || "Markdownをコピー";
}

const DEFAULT_DSL = `title: サーバーロールアウト手順
description: stagingサーバーへアプリケーションをデプロイする例です。開始前にアラートを抑止してください。

step: サーバーにログイン
note: 作業アカウントを利用
command: ssh deploy@staging.example.internal
note: 接続後に sudo -s が利用できるか確認する
warn: アクセスはメンテナンス時間内のみ許可
warning: ログイン後は即座に作業記録を開始する

step: アプリケーションを停止
command: sudo systemctl stop example.service
note: 停止完了まで最大30秒待機
note: service status で停止を確認
warn: 稼働中セッションがないか必ず確認
warning: 停止後は監視に手動通知を行うこと

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

exportButton.addEventListener("click", handleExportClick);

if (exportCopyButton) {
  exportCopyButton.addEventListener("click", handleExportCopy);
}

if (exportCloseButton) {
  exportCloseButton.addEventListener("click", () => {
    closeExportModal();
  });
}

if (exportModal) {
  exportModal.addEventListener("click", (event) => {
    if (event.target === exportModal) {
      closeExportModal();
    }
  });
}

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && exportModal && !exportModal.hidden) {
    closeExportModal();
  }
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
  const knownKeywords = new Set([
    "title",
    "description",
    "step",
    "note",
    "warn",
    "warning",
    "warnings",
    "command",
  ]);

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
          stepNotes: [],
          stepWarnings: [],
          commands: [],
        };
        break;
      case "note":
        if (!currentStep) {
          throw new Error(`${lineNumber + 1} 行目で note が定義されていますが、直前に step がありません。`);
        }
        if (!value) {
          throw new Error(`${lineNumber + 1} 行目の note が空です。`);
        }
        if (currentStep.commands.length === 0) {
          currentStep.stepNotes.push(value);
        } else {
          const targetCommand = currentStep.commands[currentStep.commands.length - 1];
          targetCommand.notes.push(value);
        }
        break;
      case "warn":
      case "warning":
      case "warnings": {
        if (!currentStep) {
          throw new Error(
            `${lineNumber + 1} 行目で warn/warning が定義されていますが、直前に step がありません。`,
          );
        }
        if (!value) {
          throw new Error(`${lineNumber + 1} 行目の warn/warning が空です。`);
        }
        if (currentStep.commands.length === 0) {
          currentStep.stepWarnings.push(value);
        } else {
          const targetCommand = currentStep.commands[currentStep.commands.length - 1];
          targetCommand.warnings.push(value);
        }
        break;
      }
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
            notes: [],
            warnings: [],
          });
          lineIndex = blockIndex;
          continue;
        }
        const commandId = `${currentStep.id}__cmd_${currentStep.commands.length}`;
        currentStep.commands.push({
          id: commandId,
          text: value,
          notes: [],
          warnings: [],
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
  currentProcedure = procedure;
  procedureTitle.textContent = procedure.title || "手順一覧";
  procedureDescription.textContent = procedure.description || "";

  stepsContainer.replaceChildren();
  activeEvidenceForm = null;

  procedure.steps.forEach((step, index) => {
    const stepElement = buildStepElement(step, index + 1);
    stepsContainer.appendChild(stepElement);
  });

  updateExportButtonState();
}

function buildStepElement(step, displayIndex) {
  const stepFragment = stepTemplate.content.cloneNode(true);
  const element = stepFragment.querySelector(".step");

  const titleEl = stepFragment.querySelector(".step-title");
  titleEl.textContent = `${displayIndex}. ${step.title}`;

  const notesEl = stepFragment.querySelector(".step-notes");
  const stepWarningsEl = stepFragment.querySelector(".step-warnings");
  const stepNotes = Array.isArray(step.stepNotes)
    ? step.stepNotes
    : step.note
    ? [step.note]
    : [];
  if (stepNotes.length > 0 && notesEl) {
    notesEl.replaceChildren();
    stepNotes.forEach((note) => {
      const item = document.createElement("li");
      item.textContent = note;
      notesEl.appendChild(item);
    });
    notesEl.style.display = "block";
  } else if (notesEl) {
    notesEl.replaceChildren();
    notesEl.style.display = "none";
  }

  const stepWarnings = Array.isArray(step.stepWarnings)
    ? step.stepWarnings
    : step.warning
    ? [step.warning]
    : [];
  if (stepWarningsEl) {
    if (stepWarnings.length > 0) {
      stepWarningsEl.replaceChildren();
      stepWarnings.forEach((warning) => {
        const item = document.createElement("li");
        item.textContent = warning;
        stepWarningsEl.appendChild(item);
      });
      stepWarningsEl.style.display = "block";
    } else {
      stepWarningsEl.replaceChildren();
      stepWarningsEl.style.display = "none";
    }
  }

  const commandsList = stepFragment.querySelector(".commands");

  step.commands.forEach((command, commandIndex) => {
    const commandFragment = commandTemplate.content.cloneNode(true);
    const listItem = commandFragment.querySelector(".command");
    const commandTextEl = commandFragment.querySelector(".command-text");
    const copyButton = commandFragment.querySelector(".copy-button");
    const historyEl = commandFragment.querySelector(".copy-history");
    const commandNotesList = commandFragment.querySelector(".command-notes");
    const commandWarningsList = commandFragment.querySelector(".command-warnings");
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

    if (commandNotesList) {
      const commandNotes = Array.isArray(command.notes) ? command.notes : [];
      if (commandNotes.length > 0) {
        commandNotesList.replaceChildren();
        commandNotes.forEach((note) => {
          const item = document.createElement("li");
          item.textContent = note;
          commandNotesList.appendChild(item);
        });
        commandNotesList.style.display = "block";
      } else {
        commandNotesList.replaceChildren();
        commandNotesList.style.display = "none";
      }
    }

    if (commandWarningsList) {
      const commandWarnings = Array.isArray(command.warnings) ? command.warnings : [];
      if (commandWarnings.length > 0) {
        commandWarningsList.replaceChildren();
        commandWarnings.forEach((warning) => {
          const item = document.createElement("li");
          item.textContent = warning;
          commandWarningsList.appendChild(item);
        });
        commandWarningsList.style.display = "block";
      } else {
        commandWarningsList.replaceChildren();
        commandWarningsList.style.display = "none";
      }
    }

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
      updateExportButtonState();
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
    updateExportButtonState();

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

function commandHasActivity(commandId) {
  const history = copyHistory.get(commandId);
  const evidences = evidenceRecords.get(commandId);
  return (history && history.length > 0) || (evidences && evidences.length > 0);
}

function updateExportButtonState() {
  if (!exportButton) {
    return;
  }
  if (!currentProcedure) {
    exportButton.disabled = true;
    return;
  }
  const hasExecuted = currentProcedure.steps.some((step) =>
    step.commands.some((command) => commandHasActivity(command.id)),
  );
  exportButton.disabled = !hasExecuted;
}

function handleExportClick() {
  const payload = buildExportPayload();
  if (!payload || !payload.steps || payload.steps.length === 0) {
    alert("エクスポート対象の実行済み手順がありません。");
    return;
  }
  const markdown = buildExportMarkdown(payload);
  lastExportMarkdown = markdown;
  openExportModal(markdown);
}

function openExportModal(markdown) {
  if (!exportModal || !exportOutput) {
    return;
  }
  exportOutput.value = markdown;
  exportOutput.scrollTop = 0;
  exportModal.hidden = false;
  if (exportCopyButton) {
    const defaultLabel = exportCopyButton.dataset.defaultLabel || "Markdownをコピー";
    exportCopyButton.textContent = defaultLabel;
    exportCopyButton.disabled = false;
    exportCopyButton.focus();
  }
}

function closeExportModal() {
  if (!exportModal || !exportOutput) {
    return;
  }
  exportModal.hidden = true;
  exportOutput.value = "";
  lastExportMarkdown = "";
  if (exportCopyButton) {
    const defaultLabel = exportCopyButton.dataset.defaultLabel || "Markdownをコピー";
    exportCopyButton.textContent = defaultLabel;
    exportCopyButton.disabled = false;
  }
  if (exportButton) {
    exportButton.focus();
  }
}

async function handleExportCopy() {
  if (!lastExportMarkdown) {
    return;
  }
  if (!exportCopyButton) {
    await writeToClipboard(lastExportMarkdown);
    return;
  }
  const defaultLabel = exportCopyButton.dataset.defaultLabel || "Markdownをコピー";
  try {
    await writeToClipboard(lastExportMarkdown);
    exportCopyButton.textContent = "コピー済み";
    exportCopyButton.disabled = true;
    setTimeout(() => {
      exportCopyButton.textContent = defaultLabel;
      exportCopyButton.disabled = false;
    }, 1500);
  } catch (error) {
    console.error("Markdown copy failed", error);
    exportCopyButton.textContent = "コピー失敗";
    exportCopyButton.disabled = true;
    setTimeout(() => {
      exportCopyButton.textContent = defaultLabel;
      exportCopyButton.disabled = false;
    }, 2000);
  }
}

function buildExportMarkdown(payload) {
  const lines = [];
  const title = payload.title && payload.title.trim() ? payload.title.trim() : "手順一覧";
  lines.push(`# ${title}`);

  if (payload.description) {
    lines.push("", payload.description.trim());
  }

  lines.push("", `エクスポート日時: ${payload.exportedAt}`);
  lines.push(`エクスポートISO: ${payload.exportedAtIso}`);

  payload.steps.forEach((step) => {
    lines.push("", `## ${step.index}. ${step.title}`);
    const stepNotes = Array.isArray(step.notes)
      ? step.notes
      : step.note
      ? [step.note]
      : [];
    if (stepNotes.length > 0) {
      stepNotes.forEach((note) => {
        lines.push(`> ${note}`);
      });
    }
    const stepWarnings = Array.isArray(step.warnings) ? step.warnings : [];
    if (stepWarnings.length > 0) {
      stepWarnings.forEach((warning) => {
        lines.push(`> **警告:** ${warning}`);
      });
    }

    step.commands.forEach((command) => {
      lines.push("", `### コマンド ${step.index}.${command.index}`);
      lines.push("", "```sh");
      command.text.split("\n").forEach((line) => {
        lines.push(line);
      });
      lines.push("```");

      const commandNotes = Array.isArray(command.notes) ? command.notes : [];
      if (commandNotes.length > 0) {
        lines.push("", "#### ノート");
        commandNotes.forEach((note) => {
          lines.push(`- ${note}`);
        });
      }

      const commandWarnings = Array.isArray(command.warnings) ? command.warnings : [];
      if (commandWarnings.length > 0) {
        lines.push("", "#### 警告");
        commandWarnings.forEach((warning) => {
          lines.push(`- ${warning}`);
        });
      }

      if (command.copyHistory && command.copyHistory.length > 0) {
        lines.push("", "#### コピー履歴");
        command.copyHistory.forEach((timestamp) => {
          lines.push(`- ${timestamp}`);
        });
      }

      if (command.evidences && command.evidences.length > 0) {
        lines.push("", "#### エビデンス");
        command.evidences.forEach((item) => {
          lines.push(`- ${item.timestamp}`);
          if (item.text) {
            lines.push("```");
            item.text.split("\n").forEach((line) => {
              lines.push(line);
            });
            lines.push("```");
          }
        });
      }
    });
  });

  const result = lines.join("\n").trim();
  return result ? `${result}\n` : "";
}

function buildExportPayload() {
  if (!currentProcedure) {
    return null;
  }

  const exportedAtDate = new Date();

  const steps = currentProcedure.steps
    .map((step, stepIndex) => {
      const stepNotes = Array.isArray(step.stepNotes)
        ? step.stepNotes
        : step.note
        ? [step.note]
        : [];
      const stepWarnings = Array.isArray(step.stepWarnings)
        ? step.stepWarnings
        : step.warning
        ? [step.warning]
        : [];
      const commands = step.commands
        .map((command, commandIndex) => {
          const history = copyHistory.get(command.id) ?? [];
          const evidences = evidenceRecords.get(command.id) ?? [];
          const commandNotes = Array.isArray(command.notes) ? command.notes : [];
          const commandWarnings = Array.isArray(command.warnings) ? command.warnings : [];
          if (history.length === 0 && evidences.length === 0) {
            return null;
          }
          return {
            index: commandIndex + 1,
            text: command.text,
            copyHistory: [...history],
            notes: [...commandNotes],
            warnings: [...commandWarnings],
            evidences: evidences.map((item) => ({
              timestamp: item.timestamp,
              iso: item.iso,
              text: item.text,
            })),
          };
        })
        .filter(Boolean);

      if (commands.length === 0) {
        return null;
      }

      return {
        index: stepIndex + 1,
        title: step.title,
        notes: [...stepNotes],
        warnings: [...stepWarnings],
        commands,
      };
    })
    .filter(Boolean);

  return {
    title: currentProcedure.title,
    description: currentProcedure.description,
    exportedAt: formatTimestamp(exportedAtDate),
    exportedAtIso: exportedAtDate.toISOString(),
    steps,
  };
}

// 初期化
if (!dslInput.value.trim()) {
  dslInput.value = DEFAULT_DSL;
}
renderProcedureFromSource(dslInput.value);
