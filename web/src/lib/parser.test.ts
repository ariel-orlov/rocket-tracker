import { describe, expect, it } from "vitest";
import { cfgFromByte, parseLine, radioErrorHint } from "./parser";
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

  it("shows a fix from older firmware (no flags) as PAD, not PAD-NOFIX", () => {
    const p = parseLine("#302 st=0 fix=1 sats=13 38.8850123,-77.7745456 alt=46 agl_max=0 batt=4576 gps_chars=44645 bad=0");
    expect(p.kind === "sample" && p.sample.state).toBe("PAD");
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
    expect(parseLine("ME,38.8848000,-77.7748000,119,9")).toMatchObject({ kind: "operator", lat: 38.8848, lon: -77.7748, altM: 119, sats: 9, courseDeg: null });
    expect(parseLine("ME,nofix,2")).toEqual({ kind: "operator-nofix", sats: 2 });
  });

  it("recognises the CSV header as a ground station", () => {
    const p = parseLine("seq,state,lat,lon,alt_m,sats,fresh,batt_mV,maxAgl_m,rssi,snr,maps");
    expect(p.kind === "status" && p.device).toBe("ground");
  });
});

describe("firmware 3 lines", () => {
  it("reads the cfg byte from the flight unit's USB line", () => {
    const p = parseLine("#40 st=0 fix=1 sats=12 38.8850000,-77.7745000 alt=120 agl_max=0 batt=4100 gps_chars=9000 bad=0 flags=07 cfg=03");
    if (p.kind !== "sample") throw new Error("not a sample");
    expect(p.sample.cfg).toEqual({ nonComp: true, landBeep: true, buzzing: false, quiet: false });
  });

  it("reads flags, cfg and fix age from the ground station's CSV", () => {
    const p = parseLine("57,LANDED,38.8862000,-77.7731000,121,10,1,4120,181,-95,4.5,1F,06,0.4,https://maps.google.com/?q=38.8862000,-77.7731000");
    if (p.kind !== "sample") throw new Error("not a sample");
    expect(p.sample).toMatchObject({ src: "ground", seq: 57, state: "LANDED", rssi: -95, snr: 4.5, flags: 0x1f, fixAgeS: 0.4 });
    expect(p.sample.cfg).toEqual({ nonComp: false, landBeep: true, buzzing: true, quiet: false });
  });

  it("marks a firmware 2 rocket heard by a firmware 3 ground station as unknown cfg", () => {
    const p = parseLine("3,PAD-READY,38.8850000,-77.7745000,120,9,1,4100,0,-60,9.0,07,--,0.2,https://maps.google.com/?q=38.885,-77.7745");
    expect(p.kind === "sample" && p.sample.cfg).toBeNull();
  });

  it("parses ME with course, speed and HDOP, and treats -1 course as unknown", () => {
    expect(parseLine("ME,38.8848000,-77.7748000,119,9,212,1.3,0.9")).toMatchObject({ kind: "operator", courseDeg: 212, speedMps: 1.3, hdop: 0.9 });
    expect(parseLine("ME,38.8848000,-77.7748000,119,9,-1,0.0,1.2")).toMatchObject({ kind: "operator", courseDeg: null });
  });

  it("parses the info and stats lines", () => {
    expect(parseLine("FU,fw=3,team=2A,power=22,mode=COMP,landbeep=1,quiet=0,radio=ok")).toEqual({
      kind: "flight-info",
      info: { fw: 3, team: "2A", powerDbm: 22, nonComp: false, landBeep: true, quiet: false, radioOk: true },
    });
    expect(parseLine("GS,fw=3,team=2A,freq=915.0,bw=500,sf=11,ble=1,name=Rocket Tracker GS")).toMatchObject({
      kind: "ground-info",
      info: { fw: 3, sf: 11, ble: true, name: "Rocket Tracker GS" },
    });
    expect(parseLine("STAT,rx=120,crc=3,other=1,up=600,ble=1")).toEqual({ kind: "stats", stats: { rx: 120, crc: 3, other: 1, upS: 600, ble: true } });
  });

  it("follows a remote command from queued to done or refused", () => {
    expect(parseLine("ACK,BUZZ,30,queued")).toMatchObject({ kind: "command", status: { cmd: "BUZZ", arg: "30", phase: "queued", via: "ground" } });
    expect(parseLine("CMD,sent,BUZZ,30,try=2")).toMatchObject({ kind: "command", status: { phase: "sent", tries: 2 } });
    expect(parseLine("CMD,done,BUZZ,30")).toMatchObject({ kind: "command", status: { phase: "done" } });
    expect(parseLine("CMD,refused,BUZZ,30,comp")).toMatchObject({ kind: "command", status: { phase: "refused", reason: "comp" } });
    expect(parseLine("ACK,LANDBEEP,0,usb")).toMatchObject({ kind: "command", status: { cmd: "LANDBEEP", phase: "done", via: "usb" } });
    expect(parseLine("ACK,BUZZ,30,radio").kind).toBe("status"); // the rocket heard it; the ground station reports the result
    expect(parseLine("ACK,FORGET")).toEqual({ kind: "forgot" });
  });

  it("reads the ground station's saved fix", () => {
    expect(parseLine("Last saved fix: 38.8862000,-77.7731000")).toEqual({ kind: "saved-fix", lat: 38.8862, lon: -77.7731 });
  });

  it("decodes every cfg bit", () => {
    expect(cfgFromByte(0x0f)).toEqual({ nonComp: true, landBeep: true, buzzing: true, quiet: true });
    expect(cfgFromByte(0)).toEqual({ nonComp: false, landBeep: false, buzzing: false, quiet: false });
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
