import { describe, expect, it } from "vitest";
import { parseLine, radioErrorHint } from "./parser";
import { bearingDeg, cardinal, distanceM, offset } from "./geo";

// Line shapes are copied from real hardware output; coordinates are replaced with
// a public place (Great Meadow, VA).

describe("flight unit USB log", () => {
  it("parses a line with no GPS yet (USB power, battery pin floating)", () => {
    const p = parseLine("#0 st=0 fix=0 sats=0 0.0000000,0.0000000 alt=0 agl_max=0 batt=56");
    expect(p.kind).toBe("sample");
    if (p.kind !== "sample") return;
    expect(p.sample).toMatchObject({ src: "flight", seq: 0, state: "PAD-NOFIX", lat: null, lon: null, sats: 0, battMv: null });
  });

  it("parses the gps_chars counter without a fix", () => {
    const p = parseLine("#5 st=0 fix=0 sats=0 0.0000000,0.0000000 alt=0 agl_max=0 batt=22 gps_chars=525 bad=0");
    expect(p.kind === "sample" && p.sample.gpsChars).toBe(525);
  });

  it("parses an outdoor fix", () => {
    const p = parseLine("#302 st=0 fix=1 sats=13 38.8850123,-77.7745456 alt=46 agl_max=0 batt=4576 gps_chars=44645 bad=0");
    if (p.kind !== "sample") throw new Error("not a sample");
    expect(p.sample.lat).toBeCloseTo(38.8850123, 7);
    expect(p.sample.lon).toBeCloseTo(-77.7745456, 7);
    expect(p.sample.fresh).toBe(true);
    expect(p.sample.altM).toBe(46);
    expect(p.sample.battMv).toBeNull(); // 4576 mV is not a real 1S reading
  });

  it("uses flags for the state when present", () => {
    const p = parseLine("#40 st=0 fix=1 sats=12 38.8850000,-77.7745000 alt=120 agl_max=0 batt=4100 gps_chars=9000 bad=0 flags=07");
    expect(p.kind === "sample" && p.sample.state).toBe("PAD-READY");
    expect(p.kind === "sample" && p.sample.battMv).toBe(4100);
    const l = parseLine("#90 st=2 fix=1 sats=11 38.8870000,-77.7700000 alt=121 agl_max=243 batt=4050 gps_chars=19000 bad=0 flags=1F");
    expect(l.kind === "sample" && l.sample.state).toBe("LANDED");
  });
});

describe("ground station", () => {
  it("parses a CSV packet with RSSI", () => {
    const p = parseLine("57,FLIGHT,38.8862000,-77.7731000,301,10,1,4120,181,-71,9.5,https://maps.google.com/?q=38.8862000,-77.7731000");
    if (p.kind !== "sample") throw new Error("not a sample");
    expect(p.sample).toMatchObject({ src: "ground", seq: 57, state: "FLIGHT", altM: 301, maxAglM: 181, rssi: -71, snr: 9.5 });
  });

  it("parses its own position and no-fix lines", () => {
    expect(parseLine("ME,38.8848000,-77.7748000,119,9")).toEqual({ kind: "operator", lat: 38.8848, lon: -77.7748, altM: 119, sats: 9 });
    expect(parseLine("ME,nofix,2")).toEqual({ kind: "operator-nofix", sats: 2 });
  });

  it("recognises the CSV header as a ground station", () => {
    const p = parseLine("seq,state,lat,lon,alt_m,sats,fresh,batt_mV,maxAgl_m,rssi,snr,maps");
    expect(p.kind === "status" && p.device).toBe("ground");
  });
});

describe("status lines", () => {
  it("knows radio OK and failures", () => {
    expect(parseLine("radio OK")).toMatchObject({ kind: "status", radio: "ok" });
    expect(parseLine("radio.begin failed: -2")).toMatchObject({ kind: "status", radio: "failed" });
    expect(radioErrorHint("radio.begin failed: -707")).toMatch(/TCXO/);
  });
  it("recognises the flight unit's boot message", () => {
    expect(parseLine("Rocket tracker flight unit")).toMatchObject({ kind: "status", device: "flight" });
  });
  it("ignores unknown text", () => {
    expect(parseLine("ESP-ROM:esp32s3-20210327").kind).toBe("other");
  });
});

describe("geo", () => {
  it("measures distance and bearing", () => {
    const [lat, lon] = offset(38.885, -77.7745, 300, 0);
    expect(distanceM(38.885, -77.7745, lat, lon)).toBeCloseTo(300, 0);
    expect(bearingDeg(38.885, -77.7745, lat, lon)).toBeCloseTo(0, 1);
    const [lat2, lon2] = offset(38.885, -77.7745, 0, 200);
    expect(bearingDeg(38.885, -77.7745, lat2, lon2)).toBeCloseTo(90, 0);
    expect(cardinal(225)).toBe("SW");
  });
});
