"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
const zigbee_herdsman_1 = require("zigbee-herdsman");
const exposes = __importStar(require("zigbee-herdsman-converters/lib/exposes"));
const logger_1 = require("zigbee-herdsman-converters/lib/logger");
const m = __importStar(require("zigbee-herdsman-converters/lib/modernExtend"));
const utils = __importStar(require("zigbee-herdsman-converters/lib/utils"));
const NS = "zhc:MINI-ZBRBS";
const e = exposes.presets;
const ea = exposes.access;
const defaultResponseOptions = { disableDefaultResponse: false };
// Mirrors zigbee-herdsman-converters lib/sonoff.ts firmwareSupportFeaturesVersion(target, "higher", {modelID}) semantics:
// missing firmware or a mismatched model means unsupported, and equal versions count as supported.
const versionAtLeast = (buildId, targetVersion) => {
    if (!buildId)
        return false;
    const currentParts = buildId.split(".").map(Number);
    const targetParts = targetVersion.split(".").map(Number);
    const length = Math.max(currentParts.length, targetParts.length);
    for (let i = 0; i < length; i++) {
        const currentPart = Number.isFinite(currentParts[i]) ? currentParts[i] : 0;
        const targetPart = Number.isFinite(targetParts[i]) ? targetParts[i] : 0;
        if (currentPart < targetPart)
            return false;
        if (currentPart > targetPart)
            return true;
    }
    return true;
};
const supportsSingleSwitchMode = (device) => device.modelID === "MINI-ZBRBS" && versionAtLeast(device.softwareBuildID, "1.2.0");
// Local copy of lib/sonoff.ts withConditionalExpose: dummy devices keep the exposes so definition exports/docs work.
const withConditionalExpose = (extend, predicate) => {
    const originalExposes = extend.exposes ?? [];
    const expose = (device, options) => {
        if (!utils.isDummyDevice(device) && !predicate(device))
            return [];
        return originalExposes.flatMap((item) => (typeof item === "function" ? item(device, options) : [item]));
    };
    return { ...extend, exposes: [expose] };
};
// Local copy of sonoffExtend.externalSwitchTriggerMode(), without the endpointNames option used by multi-gang devices.
const externalSwitchTriggerMode = () => {
    const clusterName = "customClusterEwelink";
    const attributeName = "externalTriggerMode";
    const values = ["edge", "pulse", "following(off)", "following(on)"];
    const description = `External trigger mode, which can be one of ${values.join(", ")}. ` +
        "The appropriate triggering mode can be selected according to the type of " +
        "external switch to achieve a better use experience.";
    const lookup = { edge: 0, pulse: 1, "following(off)": 2, "following(on)": 130 };
    const expose = e.enum("external_trigger_mode", ea.ALL, values).withDescription(description).withCategory("config");
    const fromZigbee = [
        {
            cluster: clusterName,
            type: ["attributeReport", "readResponse"],
            convert: (model, msg, publish, options, meta) => {
                if (msg.data.externalTriggerMode !== undefined) {
                    let switchType = "edge";
                    for (const name in lookup) {
                        if (lookup[name] === msg.data.externalTriggerMode) {
                            switchType = name;
                            break;
                        }
                    }
                    return { external_trigger_mode: switchType };
                }
            },
        },
    ];
    const toZigbee = [
        {
            key: ["external_trigger_mode"],
            convertSet: async (entity, key, value, meta) => {
                utils.assertString(value, key);
                value = value.toLowerCase();
                const tmpValue = utils.getFromLookup(value, lookup);
                await entity.write(clusterName, { [attributeName]: tmpValue }, defaultResponseOptions);
                return { state: { [key]: value } };
            },
            convertGet: async (entity, key, meta) => {
                await entity.read(clusterName, [attributeName], defaultResponseOptions);
            },
        },
    ];
    return { exposes: [expose], fromZigbee, toZigbee, isModernExtend: true };
};
const definition = {
    zigbeeModel: ["MINI-ZBRBS"],
    model: "MINI-ZBRBS",
    vendor: "SONOFF",
    description: "Zigbee smart roller shutter switch",
    extend: [
        // Only the customClusterEwelink attributes consumed by this definition are declared here.
        m.deviceAddCustomCluster("customClusterEwelink", {
            name: "customClusterEwelink",
            ID: 0xfc11,
            attributes: {
                radioPower: { name: "radioPower", ID: 0x0012, type: zigbee_herdsman_1.Zcl.DataType.INT16, write: true, min: -32768 },
                externalTriggerMode: { name: "externalTriggerMode", ID: 0x0016, type: zigbee_herdsman_1.Zcl.DataType.UINT8, write: true, max: 0xff },
                motorTravelCalibrationAction: { name: "motorTravelCalibrationAction", ID: 0x5001, type: zigbee_herdsman_1.Zcl.DataType.UINT8, write: true, max: 0xff },
                motorTravelCalibrationStatus: { name: "motorTravelCalibrationStatus", ID: 0x5012, type: zigbee_herdsman_1.Zcl.DataType.UINT8, write: true, max: 0xff },
                motorRunStatus: { name: "motorRunStatus", ID: 0x5013, type: zigbee_herdsman_1.Zcl.DataType.UINT8, write: true, max: 0xff },
                singleSwitchMode: { name: "singleSwitchMode", ID: 0x6038, type: zigbee_herdsman_1.Zcl.DataType.BOOLEAN, write: true },
            },
            commands: {},
            commandsResponse: {},
        }),
        m.windowCovering({ controls: ["lift"], coverInverted: false }),
        m.enumLookup({
            name: "motor_travel_calibration_action",
            lookup: {
                none: 0,
                start_automatic: 2,
                start_manual: 3,
                clear: 4,
                manual_2_fully_opened: 7,
                manual_3_fully_closed: 8,
            },
            cluster: "customClusterEwelink",
            attribute: "motorTravelCalibrationAction",
            description: "Calibrates the motor stroke, or clears the current one.",
            access: "ALL",
        }),
        m.enumLookup({
            name: "motor_travel_calibration_status",
            lookup: { Uncalibrated: 0, Calibrated: 1 },
            cluster: "customClusterEwelink",
            attribute: "motorTravelCalibrationStatus",
            description: "The calibration status of the curtain motor's stroke.",
            access: "STATE_GET",
        }),
        m.enumLookup({
            name: "moving",
            lookup: { stop: 0, forward: 1, reverse: 2 },
            cluster: "customClusterEwelink",
            attribute: "motorRunStatus",
            description: "The motor's current operating status, such as forward rotation, reverse rotation, and stop.",
            access: "STATE_GET",
        }),
        externalSwitchTriggerMode(),
        withConditionalExpose(m.binary({
            name: "single_switch_mode",
            cluster: "customClusterEwelink",
            attribute: "singleSwitchMode",
            description: "Single-button pulse mode: both external switch inputs toggle open/close on a short press, and move the curtain until the switch is released on a long press. Only effective while the external trigger mode is pulse.",
            valueOn: [true, 1],
            valueOff: [false, 0],
            entityCategory: "config",
        }), supportsSingleSwitchMode),
    ],
    version: "0.0.1",
    ota: {
        // imageType is duplicated with SWV-ZFE/ZNE, so modelId is added to prevent OTA firmware error detection
        modelId: "MINI-ZBRBS",
    },
    configure: async (device, coordinatorEndpoint) => {
        const endpoint = device.getEndpoint(1);
        try {
            await endpoint.read("customClusterEwelink", ["radioPower", 0x0016, 0x5012, 0x5013], defaultResponseOptions);
        }
        catch (e) {
            // Some MINI-ZBRBS units/firmware reject this read with ZCL status
            // UNSUP_CLUSTER (195), even though writing motorTravelCalibrationAction
            // on the same cluster works fine. Don't let this block the rest of
            // device configuration (binding/reporting set up by m.windowCovering()).
            logger_1.logger.error(`Configure failed: ${e}`, NS);
        }
    },
};
module.exports = definition;
