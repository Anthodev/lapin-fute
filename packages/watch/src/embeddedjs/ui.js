import {} from "piu/MC";
import { createPresentation } from "./presentation.js";

let contentStyle = null;
let footerStyle = null;

function contentStyleForDraw() {
  if (!contentStyle) {
    contentStyle = new Style({
      font: "bold 14px Gothic",
      color: "black",
      horizontal: "center",
      vertical: "middle",
      leading: 0
    });
  }
  return contentStyle;
}

function footerStyleForDraw() {
  if (!footerStyle) {
    footerStyle = new Style({
      font: "14px Gothic",
      color: "black",
      horizontal: "center",
      leading: 0
    });
  }
  return footerStyle;
}
const CONTENT_LINE_HEIGHT = 16;
const FOOTER_HEIGHT = 30;
const FOOTER_LINE_HEIGHT = 15;

function geometry(screenInfo) {
  const width = Math.max(1, Number(screenInfo.width) || 1);
  const height = Math.max(1, Number(screenInfo.height) || 1);
  const round = screenInfo.round === true;
  const insetX = round
    ? Math.max(26, Math.floor(width * 0.13))
    : Math.max(8, Math.floor(width * 0.04));
  const insetY = round
    ? Math.max(18, Math.floor(height * 0.08))
    : Math.max(6, Math.floor(height * 0.025));
  const safeHeight = Math.max(1, height - insetY * 2);
  const favoriteHeight = round ? 18 : 20;
  const headerHeight = round ? 32 : 42;
  const bodyTop = favoriteHeight + headerHeight;
  return {
    insetX,
    insetY,
    safeWidth: Math.max(1, width - insetX * 2),
    safeHeight,
    favoriteHeight,
    headerHeight,
    bodyTop,
    bodyHeight: Math.max(1, safeHeight - bodyTop - FOOTER_HEIGHT),
    round,
    hour12: screenInfo.hour12 === true
  };
}

function rowEdge(layout, index) {
  const rowLimit = layout.round ? 2 : 3;
  return layout.bodyTop
    + Math.floor(layout.bodyHeight * Math.min(index, rowLimit) / rowLimit);
}

function fittedEnd(port, string, start, end, style, width) {
  let low = start + 1;
  let high = end;
  let fitted = low;
  while (low <= high) {
    const middle = low + Math.floor((high - low) / 2);
    if (port.measureString(string.slice(start, middle), style).width <= width) {
      fitted = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  if (fitted >= end) return end;
  for (let index = fitted; index > start; index -= 1) {
    const code = string.charCodeAt(index - 1);
    if (code === 32 || code === 9) return index - 1;
  }
  return fitted;
}

function ellipsizedLine(port, string, style, width) {
  if (port.measureString(string, style).width <= width) return string;
  const ellipsis = "…";
  const ellipsisWidth = port.measureString(ellipsis, style).width;
  if (ellipsisWidth > width) return "";
  let low = 0;
  let high = string.length;
  let fitted = 0;
  while (low <= high) {
    const middle = low + Math.floor((high - low) / 2);
    const candidate = string.slice(0, middle) + ellipsis;
    if (port.measureString(candidate, style).width <= width) {
      fitted = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return string.slice(0, fitted) + ellipsis;
}

function drawRouteHeader(port, header, style, x, y, width, height) {
  const separator = header.indexOf("\n");
  const lineLabel = separator < 0 ? header : header.slice(0, separator);
  const destinationLabel = separator < 0 ? "" : header.slice(separator + 1);
  const top = y + Math.max(0, Math.floor(
    (height - CONTENT_LINE_HEIGHT * 2) / 2
  ));
  const labels = [lineLabel, destinationLabel];
  for (let index = 0; index < labels.length; index += 1) {
    if (labels[index] === "") continue;
    port.drawStyle(
      ellipsizedLine(port, labels[index], style, width),
      style,
      x,
      top + index * CONTENT_LINE_HEIGHT,
      width,
      CONTENT_LINE_HEIGHT,
      true,
      0
    );
  }
}

function wrappedLines(port, string, style, width, maximum) {
  const lines = [];
  let start = 0;
  while (start <= string.length && lines.length < maximum) {
    let hardEnd = string.indexOf("\n", start);
    if (hardEnd < 0) hardEnd = string.length;
    if (lines.length === maximum - 1) {
      lines.push(string.slice(start, hardEnd));
      break;
    }
    if (start === hardEnd) {
      lines.push("");
      if (hardEnd === string.length) break;
      start = hardEnd + 1;
      continue;
    }
    const end = port.measureString(string.slice(start, hardEnd), style).width <= width
      ? hardEnd
      : fittedEnd(port, string, start, hardEnd, style, width);
    lines.push(string.slice(start, end));
    start = end;
    while (start < hardEnd
        && (string.charCodeAt(start) === 32 || string.charCodeAt(start) === 9)) {
      start += 1;
    }
    if (start >= hardEnd) {
      if (hardEnd === string.length) break;
      start = hardEnd + 1;
    }
  }
  return lines;
}

function drawWrapped(
  port,
  string,
  style,
  x,
  y,
  width,
  height,
  lineHeight = CONTENT_LINE_HEIGHT
) {
  if (string === "") return;
  const maximum = Math.max(1, Math.floor(height / lineHeight));
  const lines = wrappedLines(port, string, style, width, maximum);
  let top = y + Math.max(0, Math.floor((height - lines.length * lineHeight) / 2));
  for (let index = 0; index < lines.length; index += 1) {
    port.drawStyle(lines[index], style, x, top, width, lineHeight, true, 0);
    top += lineHeight;
  }
}

function sameSnapshot(left, right) {
  return left
    && right
    && left.state === right.state
    && left.language === right.language
    && left.nowMs === right.nowMs
    && left.activeFavorite === right.activeFavorite
    && left.result === right.result
    && left.error === right.error
    && left.sendFailed === right.sendFailed;
}

class WatchPortBehavior extends Behavior {
  onCreate() {
    this.layout = null;
    this.snapshot = null;
  }

  onDraw(port) {
    const layout = this.layout;
    const snapshot = this.snapshot;
    port.fillColor("white", 0, 0, port.width, port.height);
    if (!layout || !snapshot) return;
    const presentation = createPresentation(snapshot, layout);
    const primaryStyle = contentStyleForDraw();
    const x = layout.insetX;
    const y = layout.insetY;
    const width = layout.safeWidth;
    const critical = presentation.stateMessage !== "" && presentation.footer === "";
    port.pushClip(x, y, width, layout.safeHeight);

    if (presentation.favoriteLabel !== "") {
      port.drawStyle(
        presentation.favoriteLabel,
        primaryStyle,
        x,
        y,
        width,
        layout.favoriteHeight,
        true,
        0
      );
    }

    if (critical) {
      const minimumTop = presentation.favoriteLabel !== "" ? layout.favoriteHeight : 0;
      const criticalHeight = layout.round ? 84 : 48;
      const top = minimumTop
        + Math.floor((layout.safeHeight - minimumTop - criticalHeight) / 2);
      drawWrapped(
        port,
        presentation.stateMessage,
        primaryStyle,
        x,
        y + top,
        width,
        criticalHeight
      );
    } else {
      drawRouteHeader(
        port,
        presentation.header,
        primaryStyle,
        x,
        y + layout.favoriteHeight,
        width,
        layout.headerHeight
      );
      if (presentation.stateMessage !== "") {
        port.drawStyle(
          presentation.stateMessage,
          primaryStyle,
          x,
          y + layout.bodyTop,
          width,
          layout.bodyHeight,
          true,
          0
        );
      } else {
        for (let index = 0; index < presentation.rows.length; index += 1) {
          const top = rowEdge(layout, index);
          port.drawStyle(
            presentation.rows[index],
            primaryStyle,
            x,
            y + top,
            width,
            rowEdge(layout, index + 1) - top,
            true,
            0
          );
        }
      }
      if (presentation.footer !== "") {
        drawWrapped(
          port,
          presentation.footer,
          footerStyleForDraw(),
          x,
          y + layout.safeHeight - FOOTER_HEIGHT,
          width,
          FOOTER_HEIGHT,
          FOOTER_LINE_HEIGHT
        );
      }
    }
    port.popClip();
  }
}

export function createWatchView(screenInfo) {
  let layout = geometry(screenInfo);
  const port = new Port(null, {
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    Behavior: WatchPortBehavior
  });
  port.behavior.layout = layout;
  const application = new Application(null, {
    clip: true,
    touchCount: 0,
    contents: [port]
  });

  return {
    application,
    render(snapshot) {
      if (sameSnapshot(port.behavior.snapshot, snapshot)) return;
      port.behavior.snapshot = snapshot;
      port.invalidate();
    },
    resize(nextScreenInfo) {
      layout = geometry(nextScreenInfo);
      port.behavior.layout = layout;
      port.invalidate();
    },
    releasePresentation() {
      port.behavior.snapshot = null;
      contentStyle = null;
      footerStyle = null;
    },
    close() {
      port.behavior.snapshot = null;
      contentStyle = null;
      footerStyle = null;
      application.empty();
    }
  };
}
