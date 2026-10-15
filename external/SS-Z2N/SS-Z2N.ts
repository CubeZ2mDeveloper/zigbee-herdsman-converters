import {Zcl} from "zigbee-herdsman";
import * as exposes from "zigbee-herdsman-converters/lib/exposes";
import {logger} from "zigbee-herdsman-converters/lib/logger";
import * as m from "zigbee-herdsman-converters/lib/modernExtend";
import * as reporting from "zigbee-herdsman-converters/lib/reporting";
import {formatUtcSecondsToIsoWithOffset, zclArrayValueToBytes} from "zigbee-herdsman-converters/lib/sonoff";
import type {DefinitionWithExtend, Fz, ModernExtend, Tz} from "zigbee-herdsman-converters/lib/types";

const NS = "zhc:SS-Z2N";
const e = exposes.presets;
const ea = exposes.access;

interface SonoffSsZ2n {
    attributes: {
        temperatureUnits: number;
        temperatureCalibration: number;
        humidityCalibration: number;
        measureInterval: number;
        comfortTemperatureMax: number;
        comfortTemperatureMin: number;
        comfortHumidityMin: number;
        comfortHumidityMax: number;
        frostProtectionTemperature: number;
        temperatureThresholdEnable: number;
        humidityThresholdEnable: number;
        frostThresholdEnable: number;
        temperatureMaxInHour: number;
        temperatureMinInHour: number;
        temperatureAverInHour: number;
        humidityMaxInHour: number;
        humidityMinInHour: number;
        humidityAverInHour: number;
        tempAndHumiHalfHourReport: number[];
    };
    commands: never;
    commandResponses: never;
}

const localExtend = {
    // Parses the 0x2010 half-hour history TLV (TotalLength + little-endian end timestamp + typed 2-byte samples).
    // Ported from the removed SNZB-02B implementation (commit before 0de459ee5); the SS-Z2N firmware reuses the same report format.
    tempAndHumiHalfHourReport: (): ModernExtend => {
        const record = e
            .composite("record", "record", ea.STATE)
            .withFeature(e.numeric("value", ea.STATE))
            .withFeature(e.text("time", ea.STATE).withDescription("Time in local ISO format with timezone"));

        const tempExpose = e
            .list("temperature_half_hour_records", ea.STATE, record)
            .withDescription("Temperature readings reported during the last 30 minutes.");

        const humiExpose = e
            .list("humidity_half_hour_records", ea.STATE, record)
            .withDescription("Humidity readings reported during the last 30 minutes.");

        const toZigbee: Tz.Converter[] = [];
        const fromZigbee: Fz.Converter<"customClusterEwelink", SonoffSsZ2n, ["attributeReport"]>[] = [
            {
                cluster: "customClusterEwelink",
                type: ["attributeReport"],
                convert: (model, msg, publish, options, meta) => {
                    const key = "tempAndHumiHalfHourReport";
                    const rawFrame = Buffer.isBuffer(msg.meta?.rawData) ? msg.meta.rawData.toString("hex") : "n/a";
                    let decodedData: string;

                    try {
                        decodedData = JSON.stringify(msg.data);
                    } catch {
                        decodedData = String(msg.data);
                    }

                    if (!Object.hasOwn(msg.data, key)) {
                        return;
                    }

                    const rawBytes = zclArrayValueToBytes(msg.data[key]);
                    if (rawBytes === undefined) {
                        logger.info(`half-hour report unsupported array payload, data=${decodedData}, raw=${rawFrame}`, NS);
                        return;
                    }
                    const data = Buffer.from(rawBytes);
                    const payloadHex = data.toString("hex");

                    if (data.length === 0) {
                        logger.info(`half-hour report empty payload, data=${decodedData}, raw=${rawFrame}, payloadHex=${payloadHex}`, NS);
                        return;
                    }

                    const leadingByte = data.readUInt8(0);
                    const hasArrayLengthHeader = data.length > 6 && leadingByte === data.length - 1;
                    let index = hasArrayLengthHeader ? 1 : 0;

                    if (data.length < index + 6) {
                        logger.info(
                            `half-hour report payload too short. totalLength=${data.length}, required>=${index + 6}, data=${decodedData}, raw=${rawFrame}, payloadHex=${payloadHex}`,
                            NS,
                        );
                        return;
                    }

                    const rawTimestamp = data.readUInt32LE(index);
                    const offset = -new Date(rawTimestamp * 1000).getTimezoneOffset();
                    const time = rawTimestamp - offset * 60;
                    index += 4;

                    const len = data.readUInt8(index);
                    index++;

                    if (len < 1) {
                        logger.info(
                            `half-hour report invalid value length=${len}, data=${decodedData}, raw=${rawFrame}, payloadHex=${payloadHex}`,
                            NS,
                        );
                        return;
                    }

                    const type = data.readUInt8(index);
                    index++;

                    if (type !== 0 && type !== 1) {
                        logger.info(
                            `half-hour report invalid type=${type}. Expected 0 (temperature) or 1 (humidity), data=${decodedData}, raw=${rawFrame}, payloadHex=${payloadHex}`,
                            NS,
                        );
                        return;
                    }

                    const dataBytes = len - 1;
                    const availableValueBytes = data.length - index;
                    const safeValueBytes = Math.min(dataBytes, availableValueBytes);
                    const sampleCount = Math.floor(safeValueBytes / 2);

                    if (dataBytes % 2 !== 0) {
                        logger.info(`half-hour report expectedValueBytes=${dataBytes} is not even, raw=${rawFrame}, payloadHex=${payloadHex}`, NS);
                    }

                    if (safeValueBytes < dataBytes) {
                        logger.info(
                            `half-hour report payload truncated. expectedValueBytes=${dataBytes}, availableValueBytes=${availableValueBytes}, raw=${rawFrame}, payloadHex=${payloadHex}`,
                            NS,
                        );
                    }

                    const valueEnd = index + safeValueBytes;
                    let timeIndex = sampleCount - 1;
                    const values = [];

                    for (let i = index; i + 1 < valueEnd; i += 2) {
                        const raw = type === 0 ? data.readInt16LE(i) : data.readUInt16LE(i);
                        const sampleTime = time - timeIndex * 60;
                        const sampleTimeIso = formatUtcSecondsToIsoWithOffset(sampleTime);
                        const sampleValue = raw / 100;

                        values.push({
                            value: sampleValue,
                            time: sampleTimeIso,
                        });
                        timeIndex--;
                    }

                    const exposeKey = type === 0 ? "temperature_half_hour_records" : "humidity_half_hour_records";
                    const payload = {[exposeKey]: values};

                    logger.info(`parsed ${type === 0 ? "temperature" : "humidity"} half-hour report with ${values.length} samples`, NS);

                    return payload;
                },
            },
        ];
        return {
            exposes: [tempExpose, humiExpose],
            fromZigbee,
            toZigbee,
            isModernExtend: true,
        };
    },
};

const definition: DefinitionWithExtend = {
    zigbeeModel: ["SS-Z2N"],
    model: "SS-Z2N",
    vendor: "SONOFF",
    description: "Soil temperature and humidity sensor",
    extend: [
        m.deviceAddCustomCluster("customClusterEwelink", {
            name: "customClusterEwelink",
            ID: 0xfc11,
            attributes: {
                temperatureUnits: {name: "temperatureUnits", ID: 0x0007, type: Zcl.DataType.UINT16, write: true},
                temperatureCalibration: {name: "temperatureCalibration", ID: 0x2003, type: Zcl.DataType.INT16, write: true},
                humidityCalibration: {name: "humidityCalibration", ID: 0x2004, type: Zcl.DataType.INT16, write: true},
                measureInterval: {name: "measureInterval", ID: 0x202d, type: Zcl.DataType.UINT16, write: true},
                temperatureMaxInHour: {name: "temperatureMaxInHour", ID: 0x2008, type: Zcl.DataType.INT16},
                temperatureMinInHour: {name: "temperatureMinInHour", ID: 0x2009, type: Zcl.DataType.INT16},
                temperatureAverInHour: {name: "temperatureAverInHour", ID: 0x200a, type: Zcl.DataType.INT16},
                humidityMaxInHour: {name: "humidityMaxInHour", ID: 0x200b, type: Zcl.DataType.UINT16},
                humidityMinInHour: {name: "humidityMinInHour", ID: 0x200c, type: Zcl.DataType.UINT16},
                humidityAverInHour: {name: "humidityAverInHour", ID: 0x200d, type: Zcl.DataType.UINT16},
                comfortTemperatureMax: {name: "comfortTemperatureMax", ID: 0x0003, type: Zcl.DataType.INT16, write: true},
                comfortTemperatureMin: {name: "comfortTemperatureMin", ID: 0x0004, type: Zcl.DataType.INT16, write: true},
                comfortHumidityMin: {name: "comfortHumidityMin", ID: 0x0005, type: Zcl.DataType.UINT16, write: true},
                comfortHumidityMax: {name: "comfortHumidityMax", ID: 0x0006, type: Zcl.DataType.UINT16, write: true},
                frostProtectionTemperature: {name: "frostProtectionTemperature", ID: 0x6002, type: Zcl.DataType.INT16, write: true},
                temperatureThresholdEnable: {name: "temperatureThresholdEnable", ID: 0x202a, type: Zcl.DataType.UINT8, write: true},
                humidityThresholdEnable: {name: "humidityThresholdEnable", ID: 0x202b, type: Zcl.DataType.UINT8, write: true},
                frostThresholdEnable: {name: "frostThresholdEnable", ID: 0x202c, type: Zcl.DataType.UINT8, write: true},
                tempAndHumiHalfHourReport: {name: "tempAndHumiHalfHourReport", ID: 0x2010, type: Zcl.DataType.ARRAY},
            },
            commands: {},
            commandsResponse: {},
        }),
        // official clusters
        m.battery({
            voltage: true,
            voltageReporting: true,
            // Reporting interval from the firmware spec (1620s / 1740s / Δ2%).
            percentageReportingConfig: {min: 1620, max: 1740, change: 2},
            // Voltage reporting interval follows the ewelink family precedent (see lib/ewelink.ts `ewelinkBattery`).
            voltageReportingConfig: {min: 3600, max: 7200, change: 100},
            // The device reports the battery percentage already converted.
            dontDividePercentage: true,
        }),
        m.temperature({valueMin: -20, valueMax: 60, reporting: {min: 120, max: 3600, change: 100}}),
        m.soilMoisture({valueMin: 0, valueMax: 100, reporting: {min: 120, max: 3600, change: 300}}),
        m.bindCluster({cluster: "genPollCtrl", clusterType: "input"}),

        // attributes
        m.numeric<"customClusterEwelink", SonoffSsZ2n>({
            name: "temperature_calibration",
            cluster: "customClusterEwelink",
            attribute: "temperatureCalibration",
            entityCategory: "config",
            description:
                "Offset to add/subtract to the reported temperature. Note: wake up the device by pressing the button on the back before changing this value.",
            valueMin: -10,
            valueMax: 10,
            scale: 100,
            valueStep: 0.1,
            unit: "°C",
        }),
        m.numeric<"customClusterEwelink", SonoffSsZ2n>({
            name: "humidity_calibration",
            cluster: "customClusterEwelink",
            attribute: "humidityCalibration",
            entityCategory: "config",
            description:
                "Offset to add/subtract to the reported relative humidity. Note: wake up the device by pressing the button on the back before changing this value.",
            valueMin: -100,
            valueMax: 100,
            scale: 100,
            valueStep: 1,
            unit: "%",
        }),
        m.enumLookup<"customClusterEwelink", SonoffSsZ2n>({
            name: "temperature_units",
            lookup: {celsius: 0, fahrenheit: 1},
            cluster: "customClusterEwelink",
            attribute: "temperatureUnits",
            entityCategory: "config",
            description:
                "The unit of the temperature reported by the device. Note: wake up the device by pressing the button on the back before changing this value.",
        }),
        m.enumLookup<"customClusterEwelink", SonoffSsZ2n>({
            name: "measure_interval",
            lookup: {"1_min": 0, "5_min": 1, "15_min": 2, "30_min": 3, "1_hour": 4, "2_hours": 5},
            cluster: "customClusterEwelink",
            attribute: "measureInterval",
            entityCategory: "config",
            description:
                "Detection and reporting frequency of the sensor, defaults to 5 minutes. Note: wake up the device by pressing the button on the back before changing this value.",
        }),
        m.numeric<"customClusterEwelink", SonoffSsZ2n>({
            name: "comfort_temperature_min",
            cluster: "customClusterEwelink",
            attribute: "comfortTemperatureMin",
            entityCategory: "config",
            description:
                "Lower temperature threshold for the low-temperature alarm: the device alerts when the temperature drops below this value. Defaults to 8 °C. Note: wake up the device by pressing the button on the back before changing this value.",
            valueMin: -20,
            valueMax: 60,
            valueStep: 1,
            scale: 100,
            unit: "°C",
        }),
        m.numeric<"customClusterEwelink", SonoffSsZ2n>({
            name: "comfort_temperature_max",
            cluster: "customClusterEwelink",
            attribute: "comfortTemperatureMax",
            entityCategory: "config",
            description:
                "Upper temperature threshold for the high-temperature alarm: the device alerts when the temperature rises above this value. Defaults to 32 °C. Note: wake up the device by pressing the button on the back before changing this value.",
            valueMin: -20,
            valueMax: 60,
            valueStep: 1,
            scale: 100,
            unit: "°C",
        }),
        m.numeric<"customClusterEwelink", SonoffSsZ2n>({
            name: "comfort_humidity_min",
            cluster: "customClusterEwelink",
            attribute: "comfortHumidityMin",
            entityCategory: "config",
            description:
                "Lower relative humidity threshold for the dry alarm: the device alerts when the humidity drops below this value. Defaults to 15%. Note: wake up the device by pressing the button on the back before changing this value.",
            valueMin: 1,
            valueMax: 99,
            valueStep: 1,
            scale: 100,
            unit: "%",
        }),
        m.numeric<"customClusterEwelink", SonoffSsZ2n>({
            name: "comfort_humidity_max",
            cluster: "customClusterEwelink",
            attribute: "comfortHumidityMax",
            entityCategory: "config",
            description:
                "Upper relative humidity threshold for the damp alarm: the device alerts when the humidity rises above this value. Defaults to 30%. Note: wake up the device by pressing the button on the back before changing this value.",
            valueMin: 1,
            valueMax: 99,
            valueStep: 1,
            scale: 100,
            unit: "%",
        }),
        // Frost alarm range -10~20℃ with default 5℃, per PRD §5.8.4.
        m.numeric<"customClusterEwelink", SonoffSsZ2n>({
            name: "frost_protection_temperature",
            cluster: "customClusterEwelink",
            attribute: "frostProtectionTemperature",
            entityCategory: "config",
            description:
                "Frost protection threshold: the device triggers the frost alarm when the temperature drops below this value. Defaults to 5 °C. Note: wake up the device by pressing the button on the back before changing this value.",
            valueMin: -10,
            valueMax: 20,
            valueStep: 1,
            scale: 100,
            unit: "°C",
        }),
        m.binary<"customClusterEwelink", SonoffSsZ2n>({
            name: "temperature_threshold_enable",
            cluster: "customClusterEwelink",
            attribute: "temperatureThresholdEnable",
            entityCategory: "config",
            description:
                "Enables/disables the temperature threshold alarm. Note: wake up the device by pressing the button on the back before changing this value.",
            valueOn: ["ON", 0x01],
            valueOff: ["OFF", 0x00],
        }),
        m.binary<"customClusterEwelink", SonoffSsZ2n>({
            name: "humidity_threshold_enable",
            cluster: "customClusterEwelink",
            attribute: "humidityThresholdEnable",
            entityCategory: "config",
            description:
                "Enables/disables the humidity threshold alarm. Note: wake up the device by pressing the button on the back before changing this value.",
            valueOn: ["ON", 0x01],
            valueOff: ["OFF", 0x00],
        }),
        m.binary<"customClusterEwelink", SonoffSsZ2n>({
            name: "frost_threshold_enable",
            cluster: "customClusterEwelink",
            attribute: "frostThresholdEnable",
            entityCategory: "config",
            description:
                "Enables/disables the frost protection threshold alarm. Note: wake up the device by pressing the button on the back before changing this value.",
            valueOn: ["ON", 0x01],
            valueOff: ["OFF", 0x00],
        }),
        m.numeric<"customClusterEwelink", SonoffSsZ2n>({
            name: "temperature_max_in_hour",
            cluster: "customClusterEwelink",
            attribute: "temperatureMaxInHour",
            description: "Maximum temperature recorded in the last hour",
            access: "STATE_GET",
            scale: 100,
            unit: "°C",
        }),
        m.numeric<"customClusterEwelink", SonoffSsZ2n>({
            name: "temperature_min_in_hour",
            cluster: "customClusterEwelink",
            attribute: "temperatureMinInHour",
            description: "Minimum temperature recorded in the last hour",
            access: "STATE_GET",
            scale: 100,
            unit: "°C",
        }),
        m.numeric<"customClusterEwelink", SonoffSsZ2n>({
            name: "temperature_aver_in_hour",
            cluster: "customClusterEwelink",
            attribute: "temperatureAverInHour",
            description: "Average temperature recorded in the last hour",
            access: "STATE_GET",
            scale: 100,
            unit: "°C",
        }),
        m.numeric<"customClusterEwelink", SonoffSsZ2n>({
            name: "humidity_max_in_hour",
            cluster: "customClusterEwelink",
            attribute: "humidityMaxInHour",
            description: "Maximum humidity recorded in the last hour",
            access: "STATE_GET",
            scale: 100,
            unit: "%",
        }),
        m.numeric<"customClusterEwelink", SonoffSsZ2n>({
            name: "humidity_min_in_hour",
            cluster: "customClusterEwelink",
            attribute: "humidityMinInHour",
            description: "Minimum humidity recorded in the last hour",
            access: "STATE_GET",
            scale: 100,
            unit: "%",
        }),
        m.numeric<"customClusterEwelink", SonoffSsZ2n>({
            name: "humidity_aver_in_hour",
            cluster: "customClusterEwelink",
            attribute: "humidityAverInHour",
            description: "Average humidity recorded in the last hour",
            access: "STATE_GET",
            scale: 100,
            unit: "%",
        }),
        localExtend.tempAndHumiHalfHourReport(),
    ],
    configure: async (device, coordinatorEndpoint) => {
        const endpoint = device.getEndpoint(1);
        if (!endpoint) {
            throw new Error("Endpoint 1 not found");
        }
        await reporting.bind(endpoint, coordinatorEndpoint, ["genOnOff"]);
    },
    ota: true,
};

export = definition;