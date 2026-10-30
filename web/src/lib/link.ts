import { bleActive, connectBle, disconnectBle, writeBle } from "./ble";
import { connectSerial, disconnectSerial, serialActive, writeSerial } from "./serial";
import { getState, logApp, noteCommandSent, setState } from "./store";
import type { CommandName } from "./types";

/** One link at a time: opening USB closes Bluetooth and the other way round. */
export async function connectUsb() {
  await connectSerial(async () => {
    if (bleActive()) await disconnectBle();
  });
}

export async function connectBluetooth() {
  await connectBle(async () => {
    if (serialActive()) await disconnectSerial();
  });
}

export async function disconnect() {
  if (bleActive() || getState().conn === "ble") await disconnectBle();
  if (serialActive() || getState().conn === "usb") await disconnectSerial();
  if (getState().conn === "connecting") setState({ conn: "idle" });
}

/** Send a text line to whichever board is connected. Shown in the terminal as "> LINE". */
export async function sendLine(line: string): Promise<boolean> {
  const conn = getState().conn;
  try {
    if (conn === "ble") await writeBle(line);
    else if (conn === "usb") await writeSerial(line);
    else throw new Error("Connect a board first.");
    logApp(`> ${line}`, "cmd");
    return true;
  } catch (e) {
    logApp(`Couldn't send "${line}": ${e instanceof Error ? e.message : String(e)}`, "error");
    return false;
  }
}

/**
 * The same words work on both boards: the flight unit acts on them over USB, the ground station
 * passes BUZZ / LANDBEEP / QUIET on to a non-competition rocket by radio.
 */
export async function sendCommand(cmd: CommandName, arg = "") {
  const via = getState().device === "flight" ? "usb" : "ground";
  const ok = await sendLine(arg ? `${cmd} ${arg}` : cmd);
  if (ok) noteCommandSent(cmd, arg, via);
}

export const buzz = (seconds: number) => sendCommand("BUZZ", String(seconds));
export const setLandBeep = (on: boolean) => sendCommand("LANDBEEP", on ? "ON" : "OFF");
export const setQuiet = (on: boolean) => sendCommand("QUIET", on ? "ON" : "OFF");
export const setMode = (nonComp: boolean) => sendCommand("MODE", nonComp ? "NONCOMP" : "COMP");
export const beepTest = () => sendCommand("BEEP");
export const cancelCommand = () => sendLine("CANCEL");
export const forgetGroundFix = () => sendLine("FORGET");
