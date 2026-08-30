import {} from "piu/MC";
import { copy, formatMinutes } from "./localization.js";

const BACKGROUND_SKIN = new Skin({ fill: "white" });
const HEADER_STYLE = new Style({
  font: "bold 18px Gothic",
  color: "black",
  horizontal: "center",
  leading: 1
});
const BODY_STYLE = new Style({
  font: "18px Gothic",
  color: "black",
  horizontal: "center",
  leading: 2
});
const FOOTER_STYLE = new Style({
  font: "14px Gothic",
  color: "black",
  horizontal: "center"
});

function geometry(screenInfo) {
  const width = Math.max(1, Number(screenInfo.width) || 1);
  const height = Math.max(1, Number(screenInfo.height) || 1);
  const round = screenInfo.round === true;
  const horizontal = round
    ? Math.max(26, Math.floor(width * 0.13))
    : Math.max(8, Math.floor(width * 0.04));
  const vertical = round
    ? Math.max(18, Math.floor(height * 0.08))
    : Math.max(6, Math.floor(height * 0.025));
  const headerHeight = Math.floor(height * (round ? 0.27 : 0.25));
  const footerHeight = Math.floor(height * 0.12);
  return {
    rows: round ? 2 : 3,
    header: {
      left: horizontal,
      right: horizontal,
      top: vertical,
      height: headerHeight
    },
    body: {
      left: horizontal,
      right: horizontal,
      top: vertical + headerHeight,
      bottom: vertical + footerHeight
    },
    footer: {
      left: horizontal,
      right: horizontal,
      bottom: vertical,
      height: footerHeight
    }
  };
}

function setString(content, value) {
  if (content.string !== value) content.string = value;
}

function headerText(snapshot) {
  if (!snapshot.favorite) return copy(snapshot.language, "appName");
  return snapshot.favorite.lineLabel + " → " + snapshot.favorite.destinationLabel;
}

function bodyText(snapshot, rowLimit) {
  if (snapshot.result) {
    if (snapshot.result.departures.length === 0) {
      return copy(snapshot.language, "noDepartures");
    }
    const lines = [];
    const count = Math.min(rowLimit, snapshot.result.departures.length);
    for (let index = 0; index < count; index += 1) {
      lines.push(formatMinutes(snapshot.language, snapshot.result.departures[index].minutes));
    }
    return lines.join("\n");
  }
  if (snapshot.error || snapshot.sendFailed) return copy(snapshot.language, "unavailable");
  return snapshot.favorite
    ? copy(snapshot.language, "waiting")
    : copy(snapshot.language, "synchronizing");
}

function footerText(snapshot) {
  if (snapshot.result) return copy(snapshot.language, "recordedFixture");
  if (!snapshot.favorite) return "";
  return snapshot.favorite.displayName || snapshot.favorite.stopLabel;
}

export function createWatchView(screenInfo) {
  let layout = geometry(screenInfo);
  const header = new Text(null, {
    ...layout.header,
    style: HEADER_STYLE,
    string: ""
  });
  const body = new Text(null, {
    ...layout.body,
    style: BODY_STYLE,
    string: ""
  });
  const footer = new Text(null, {
    ...layout.footer,
    style: FOOTER_STYLE,
    string: ""
  });
  const application = new Application(null, {
    skin: BACKGROUND_SKIN,
    touchCount: 0,
    displayListLength: 2048,
    contents: [header, body, footer]
  });

  return {
    application,
    render(snapshot) {
      setString(header, headerText(snapshot));
      setString(body, bodyText(snapshot, layout.rows));
      setString(footer, footerText(snapshot));
    },
    resize(nextScreenInfo) {
      layout = geometry(nextScreenInfo);
      header.coordinates = layout.header;
      body.coordinates = layout.body;
      footer.coordinates = layout.footer;
    },
    close() {
      application.empty();
    }
  };
}
