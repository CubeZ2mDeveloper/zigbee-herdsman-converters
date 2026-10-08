import type {Mock} from "vitest";
import {beforeEach, describe, expect, it, vi} from "vitest";
import type {Models as ZHModels} from "zigbee-herdsman";
import {findByDevice} from "../src/index";
import {Enum} from "../src/lib/exposes";
import type {Definition, DummyDevice, Fz, KeyValue, OnEvent, Tz} from "../src/lib/types";
import {mockDevice} from "./utils";

interface State {
    // biome-ignore lint/style/useNamingConvention: ignored using `--suppress`
    readonly weekly_schedule_sunday?: string;
    // biome-ignore lint/style/useNamingConvention: ignored using `--suppress`
    readonly weekly_schedule_monday?: string;
    // biome-ignore lint/style/useNamingConvention: ignored using `--suppress`
    readonly weekly_schedule_tuesday?: string;
    // biome-ignore lint/style/useNamingConvention: ignored using `--suppress`
    readonly weekly_schedule_wednesday?: string;
    // biome-ignore lint/style/useNamingConvention: ignored using `--suppress`
    readonly weekly_schedule_thursday?: string;
    // biome-ignore lint/style/useNamingConvention: ignored using `--suppress`
    readonly weekly_schedule_friday?: string;
    // biome-ignore lint/style/useNamingConvention: ignored using `--suppress`
    readonly weekly_schedule_saturday?: string;
}

describe("Sonoff TRVZB", () => {
    let trv: Definition;

    beforeEach(async () => {
        const device = mockDevice({modelID: "TRVZB", endpoints: []});

        trv = await findByDevice(device);
    });

    describe("weekly schedule", () => {
        describe("fromZigbee", () => {
            // biome-ignore lint/suspicious/noExplicitAny: generic
            let fzConverter: Fz.Converter<any, any, any>;
            let meta: Fz.Meta;

            beforeEach(() => {
                fzConverter = trv.fromZigbee.find((c) => c.cluster === "hvacThermostat" && c.type.includes("commandGetWeeklyScheduleRsp"));

                meta = {
                    state: {},
                    device: null,
                    deviceExposesChanged: null,
                };
            });

            const days = [
                {dayofweek: 0x01, day: "sunday"},
                {dayofweek: 0x02, day: "monday"},
                {dayofweek: 0x04, day: "tuesday"},
                {dayofweek: 0x08, day: "wednesday"},
                {dayofweek: 0x10, day: "thursday"},
                {dayofweek: 0x20, day: "friday"},
                {dayofweek: 0x40, day: "saturday"},
            ];

            describe.each(days)("when a commandGetWeeklyScheduleRsp message is received for $day", ({dayofweek, day}) => {
                it("should set state", () => {
                    // biome-ignore lint/suspicious/noExplicitAny: generic
                    const msg: Fz.Message<any, any, any> = {
                        data: {
                            dayofweek: dayofweek,
                            transitions: [
                                {
                                    transitionTime: 0,
                                    heatSetpoint: 500,
                                },
                                {
                                    transitionTime: 90,
                                    heatSetpoint: 1000,
                                },
                            ],
                        },
                        endpoint: null,
                        device: null,
                        meta: null,
                        groupID: null,
                        type: "commandGetWeeklyScheduleRsp",
                        cluster: "hvacThermostat",
                        linkquality: 0,
                    };

                    const state = fzConverter.convert(trv, msg, null, null, meta) as State;

                    expect(state).toEqual({
                        [`weekly_schedule_${day}`]: "00:00/5 01:30/10",
                    });
                });
            });

            describe("when multiple commandGetWeeklyScheduleRsp messages are received for different days", () => {
                let state1: State;
                let state2: State;

                beforeEach(() => {
                    // biome-ignore lint/suspicious/noExplicitAny: generic
                    const msg1: Fz.Message<any, any, any> = {
                        data: {
                            dayofweek: 0x01,
                            transitions: [
                                {
                                    transitionTime: 0,
                                    heatSetpoint: 500,
                                },
                                {
                                    transitionTime: 90,
                                    heatSetpoint: 1000,
                                },
                            ],
                        },
                        endpoint: null,
                        device: null,
                        meta: null,
                        groupID: null,
                        type: "commandGetWeeklyScheduleRsp",
                        cluster: "hvacThermostat",
                        linkquality: 0,
                    };

                    // biome-ignore lint/suspicious/noExplicitAny: generic
                    const msg2: Fz.Message<any, any, any> = {
                        data: {
                            dayofweek: 0x02,
                            transitions: [
                                {
                                    transitionTime: 60,
                                    heatSetpoint: 550,
                                },
                                {
                                    transitionTime: 180,
                                    heatSetpoint: 1250,
                                },
                            ],
                        },
                        endpoint: null,
                        device: null,
                        meta: null,
                        groupID: null,
                        type: "commandGetWeeklyScheduleRsp",
                        cluster: "hvacThermostat",
                        linkquality: 0,
                    };

                    state1 = fzConverter.convert(trv, msg1, null, null, meta) as State;
                    // Simulate state accumulation - update meta.state with first result
                    meta.state = {...meta.state, ...state1};
                    state2 = fzConverter.convert(trv, msg2, null, null, meta) as State;
                });

                it("should return individual day schedules with accumulated composite", () => {
                    expect(state1).toEqual({
                        weekly_schedule_sunday: "00:00/5 01:30/10",
                    });
                    expect(state2).toEqual({
                        weekly_schedule_monday: "01:00/5.5 03:00/12.5",
                    });
                });
            });
        });

        describe("toZigbee", () => {
            let tzConverter: Tz.Converter;
            let meta: Tz.Meta;
            let commandFn: Mock;
            let endpoint: ZHModels.Endpoint;

            const invalidTransitions = [
                {transition: "", description: "empty string"},
                {transition: "0:00/5", description: "hours not two digits"},
                {transition: "24:00/5", description: "hours greater than 23"},
                {transition: "23:0/5", description: "minutes not two digits"},
                {transition: "23:60/5", description: "minutes greater than 59"},
                {transition: "23:59", description: "missing slash"},
                {transition: "23:59/", description: "missing temperature"},
                {transition: "23:59/-1", description: "negative temperature"},
                {transition: "23:59/523:59/5", description: "missing space separator"},
                {transition: "00:00/10.1", description: "temperature decimal point is not 0.5"},
            ];

            beforeEach(() => {
                tzConverter = trv.toZigbee.find((c) => c.key.includes("weekly_schedule_monday"));

                meta = {
                    state: {},
                    device: null,
                    message: null,
                    mapped: null,
                    options: null,
                    publish: null,
                    endpoint_name: null,
                };

                commandFn = vi.fn();

                endpoint = {
                    command: commandFn,
                } as unknown as ZHModels.Endpoint;
            });

            it.each(invalidTransitions)("should throw error if transition format is invalid ($description)", async ({transition, description}) => {
                await expect(tzConverter.convertSet(endpoint, "weekly_schedule_monday", transition, meta)).rejects.toEqual(
                    new Error(`Invalid schedule for monday: transitions must be in format HH:mm/temperature (e.g. 12:00/15.5), found: ${transition}`),
                );
            });

            it("should throw error if first transition does not start at 00:00", async () => {
                await expect(tzConverter.convertSet(endpoint, "weekly_schedule_monday", "00:01/5", meta)).rejects.toEqual(
                    new Error("Invalid schedule for monday: the first transition of each day should start at 00:00"),
                );
            });

            it("should throw error if day has more than 6 transitions", async () => {
                await expect(
                    tzConverter.convertSet(endpoint, "weekly_schedule_monday", "00:00/1 00:00/1 00:00/1 00:00/1 00:00/1 00:00/1 00:00/1", meta),
                ).rejects.toEqual(new Error("Invalid schedule for monday: days must have no more than 6 transitions"));
            });

            it.each([3, 36])("should throw error if temperature value is outside of valid range ($temperature) ", async (temperature) => {
                await expect(tzConverter.convertSet(endpoint, "weekly_schedule_monday", `00:00/${temperature}`, meta)).rejects.toEqual(
                    new Error(`Invalid schedule for monday: temperature value must be between 4-35 (inclusive), found: ${temperature}`),
                );
            });

            it("should send setWeeklySchedule command if transitions are valid", async () => {
                await tzConverter.convertSet(endpoint, "weekly_schedule_sunday", "00:00/5 06:30/10.5 12:00/15 18:30/20 20:45/15.5 23:00/4", meta);

                expect(commandFn).toHaveBeenCalledWith(
                    "hvacThermostat",
                    "setWeeklySchedule",
                    {
                        dayofweek: 1,
                        numoftrans: 6,
                        mode: 1,
                        transitions: [
                            {
                                heatSetpoint: 500,
                                transitionTime: 0,
                            },
                            {
                                heatSetpoint: 1050,
                                transitionTime: 390,
                            },
                            {
                                heatSetpoint: 1500,
                                transitionTime: 720,
                            },
                            {
                                heatSetpoint: 2000,
                                transitionTime: 1110,
                            },
                            {
                                heatSetpoint: 1550,
                                transitionTime: 1245,
                            },
                            {
                                heatSetpoint: 400,
                                transitionTime: 1380,
                            },
                        ],
                    },
                    {},
                );
            });

            it("should send setWeeklySchedule command with transitions in ascending time order", async () => {
                await tzConverter.convertSet(endpoint, "weekly_schedule_sunday", "00:00/5 12:00/15 06:30/10.5", meta);

                expect(commandFn).toHaveBeenCalledWith(
                    "hvacThermostat",
                    "setWeeklySchedule",
                    {
                        dayofweek: 1,
                        numoftrans: 3,
                        mode: 1,
                        transitions: [
                            {
                                heatSetpoint: 500,
                                transitionTime: 0,
                            },
                            {
                                heatSetpoint: 1050,
                                transitionTime: 390,
                            },
                            {
                                heatSetpoint: 1500,
                                transitionTime: 720,
                            },
                        ],
                    },
                    {},
                );
            });

            it("should send a setWeeklySchedule command for each day", async () => {
                await tzConverter.convertSet(endpoint, "weekly_schedule_sunday", "00:00/5", meta);
                await tzConverter.convertSet(endpoint, "weekly_schedule_monday", "00:00/10", meta);
                await tzConverter.convertSet(endpoint, "weekly_schedule_tuesday", "00:00/15", meta);

                expect(commandFn).toHaveBeenCalledTimes(3);

                expect(commandFn).toHaveBeenCalledWith(
                    "hvacThermostat",
                    "setWeeklySchedule",
                    {
                        dayofweek: 1,
                        numoftrans: 1,
                        mode: 1,
                        transitions: [
                            {
                                heatSetpoint: 500,
                                transitionTime: 0,
                            },
                        ],
                    },
                    {},
                );

                expect(commandFn).toHaveBeenCalledWith(
                    "hvacThermostat",
                    "setWeeklySchedule",
                    {
                        dayofweek: 2,
                        numoftrans: 1,
                        mode: 1,
                        transitions: [
                            {
                                heatSetpoint: 1000,
                                transitionTime: 0,
                            },
                        ],
                    },
                    {},
                );

                expect(commandFn).toHaveBeenCalledWith(
                    "hvacThermostat",
                    "setWeeklySchedule",
                    {
                        dayofweek: 4,
                        numoftrans: 1,
                        mode: 1,
                        transitions: [
                            {
                                heatSetpoint: 1500,
                                transitionTime: 0,
                            },
                        ],
                    },
                    {},
                );
            });

            it("should return state when setting a single day", async () => {
                const result = await tzConverter.convertSet(endpoint, "weekly_schedule_friday", "00:00/18", meta);

                expect(commandFn).toHaveBeenCalledTimes(1);
                expect(result).toEqual({
                    state: {
                        weekly_schedule_friday: "00:00/18",
                    },
                });
            });

            describe("multi-day batch updates via meta.message", () => {
                it("should process multiple days with different schedules in separate commands", async () => {
                    const multiDayMeta = {
                        ...meta,
                        message: {
                            weekly_schedule_monday: "00:00/10",
                            weekly_schedule_tuesday: "00:00/15",
                            weekly_schedule_wednesday: "00:00/20",
                        },
                    };

                    // Call for the first key alphabetically (monday comes first)
                    const result = await tzConverter.convertSet(endpoint, "weekly_schedule_monday", "00:00/10", multiDayMeta);

                    expect(commandFn).toHaveBeenCalledTimes(3);

                    expect(commandFn).toHaveBeenCalledWith(
                        "hvacThermostat",
                        "setWeeklySchedule",
                        {
                            dayofweek: 2, // Monday
                            numoftrans: 1,
                            mode: 1,
                            transitions: [{heatSetpoint: 1000, transitionTime: 0}],
                        },
                        {},
                    );

                    expect(commandFn).toHaveBeenCalledWith(
                        "hvacThermostat",
                        "setWeeklySchedule",
                        {
                            dayofweek: 4, // Tuesday
                            numoftrans: 1,
                            mode: 1,
                            transitions: [{heatSetpoint: 1500, transitionTime: 0}],
                        },
                        {},
                    );

                    expect(commandFn).toHaveBeenCalledWith(
                        "hvacThermostat",
                        "setWeeklySchedule",
                        {
                            dayofweek: 8, // Wednesday
                            numoftrans: 1,
                            mode: 1,
                            transitions: [{heatSetpoint: 2000, transitionTime: 0}],
                        },
                        {},
                    );

                    expect(result).toEqual({
                        state: {
                            weekly_schedule_monday: "00:00/10",
                            weekly_schedule_tuesday: "00:00/15",
                            weekly_schedule_wednesday: "00:00/20",
                        },
                    });
                });

                it("should combine days with identical schedules into a single command", async () => {
                    const multiDayMeta = {
                        ...meta,
                        message: {
                            weekly_schedule_monday: "00:00/10 08:00/20",
                            weekly_schedule_tuesday: "00:00/10 08:00/20",
                            weekly_schedule_wednesday: "00:00/15",
                        },
                    };

                    const result = await tzConverter.convertSet(endpoint, "weekly_schedule_monday", "00:00/10 08:00/20", multiDayMeta);

                    // Should send 2 commands: one for monday+tuesday (same schedule), one for wednesday
                    expect(commandFn).toHaveBeenCalledTimes(2);

                    // Verify monday+tuesday combined (dayofweek = 2 | 4 = 6)
                    expect(commandFn).toHaveBeenCalledWith(
                        "hvacThermostat",
                        "setWeeklySchedule",
                        {
                            dayofweek: 6, // Monday (2) + Tuesday (4)
                            numoftrans: 2,
                            mode: 1,
                            transitions: [
                                {heatSetpoint: 1000, transitionTime: 0},
                                {heatSetpoint: 2000, transitionTime: 480},
                            ],
                        },
                        {},
                    );

                    // Verify wednesday separate
                    expect(commandFn).toHaveBeenCalledWith(
                        "hvacThermostat",
                        "setWeeklySchedule",
                        {
                            dayofweek: 8, // Wednesday
                            numoftrans: 1,
                            mode: 1,
                            transitions: [{heatSetpoint: 1500, transitionTime: 0}],
                        },
                        {},
                    );

                    expect(result).toEqual({
                        state: {
                            weekly_schedule_monday: "00:00/10 08:00/20",
                            weekly_schedule_tuesday: "00:00/10 08:00/20",
                            weekly_schedule_wednesday: "00:00/15",
                        },
                    });
                });

                it("should handle all seven days with same schedule in a single command", async () => {
                    const schedule = "00:00/16 08:00/20 22:00/16";
                    const multiDayMeta = {
                        ...meta,
                        message: {
                            weekly_schedule_sunday: schedule,
                            weekly_schedule_monday: schedule,
                            weekly_schedule_tuesday: schedule,
                            weekly_schedule_wednesday: schedule,
                            weekly_schedule_thursday: schedule,
                            weekly_schedule_friday: schedule,
                            weekly_schedule_saturday: schedule,
                        },
                    };

                    // Call for the first key alphabetically (friday)
                    const result = await tzConverter.convertSet(endpoint, "weekly_schedule_friday", schedule, multiDayMeta);

                    // All days have the same schedule, so only 1 command should be sent
                    expect(commandFn).toHaveBeenCalledTimes(1);

                    // dayofweek = 1 | 2 | 4 | 8 | 16 | 32 | 64 = 127 (all days)
                    expect(commandFn).toHaveBeenCalledWith(
                        "hvacThermostat",
                        "setWeeklySchedule",
                        {
                            dayofweek: 127,
                            numoftrans: 3,
                            mode: 1,
                            transitions: [
                                {heatSetpoint: 1600, transitionTime: 0},
                                {heatSetpoint: 2000, transitionTime: 480},
                                {heatSetpoint: 1600, transitionTime: 1320},
                            ],
                        },
                        {},
                    );

                    expect(result).toEqual({
                        state: {
                            weekly_schedule_sunday: schedule,
                            weekly_schedule_monday: schedule,
                            weekly_schedule_tuesday: schedule,
                            weekly_schedule_wednesday: schedule,
                            weekly_schedule_thursday: schedule,
                            weekly_schedule_friday: schedule,
                            weekly_schedule_saturday: schedule,
                        },
                    });
                });

                it("should validate schedule format for multi-day updates", async () => {
                    const multiDayMeta = {
                        ...meta,
                        message: {
                            weekly_schedule_monday: "invalid_schedule",
                            weekly_schedule_tuesday: "00:00/15",
                        },
                    };

                    await expect(tzConverter.convertSet(endpoint, "weekly_schedule_monday", "invalid_schedule", multiDayMeta)).rejects.toEqual(
                        new Error(
                            "Invalid schedule for monday: transitions must be in format HH:mm/temperature (e.g. 12:00/15.5), found: invalid_schedule",
                        ),
                    );
                });
            });
        });
    });
});

describe("Sonoff SWV", () => {
    it("continues configuring when optional water shortage auto-close attribute is unsupported", async () => {
        const device = mockDevice({
            modelID: "SWV",
            endpoints: [{ID: 1, inputClusters: ["genPowerCfg", "genOnOff", "msFlowMeasurement"], inputClusterIDs: [0xfc11]}],
        });
        const coordinator = mockDevice({modelID: "Coordinator", endpoints: [{ID: 1}]});
        const endpoint = device.getEndpoint(1);
        const readFn = endpoint.read as Mock;
        const swv = await findByDevice(device);

        readFn.mockImplementation((_cluster: string, attributes: number[]) => {
            if (attributes.includes(0x5011)) {
                return Promise.reject(new Error("Status 'UNSUPPORTED_ATTRIBUTE'"));
            }

            return Promise.resolve({});
        });

        await expect(swv.configure(device, coordinator.getEndpoint(1), swv)).resolves.toBeUndefined();

        expect(readFn).toHaveBeenCalledWith("customClusterEwelink", [0x500c]);
        expect(readFn).toHaveBeenCalledWith("customClusterEwelink", [0x5011]);
    });
});

describe("Sonoff SNZB-02DR2", () => {
    let device: Definition;
    let endpoint: ZHModels.Endpoint;
    let writeFn: Mock;
    let meta: Tz.Meta;

    beforeEach(async () => {
        device = await findByDevice(mockDevice({modelID: "SNZB-02DR2", endpoints: [{ID: 1}]}));

        writeFn = vi.fn();
        endpoint = {write: writeFn} as unknown as ZHModels.Endpoint;
        meta = {
            state: {},
            device: null,
            message: null,
            mapped: null,
            options: null,
            publish: null,
            endpoint_name: null,
        };
    });

    describe("toZigbee", () => {
        it("enables the external display via temperature_sensor_select", async () => {
            const tzConverter = device.toZigbee.find((c) => c.key.includes("temperature_sensor_select"));

            await tzConverter.convertSet(endpoint, "temperature_sensor_select", "external", meta);

            expect(writeFn).toHaveBeenCalledWith("customSonoffSnzb02dr2", {temperatureSensorSelect: 1}, undefined);
        });

        it("disables the external display via temperature_sensor_select", async () => {
            const tzConverter = device.toZigbee.find((c) => c.key.includes("temperature_sensor_select"));

            await tzConverter.convertSet(endpoint, "temperature_sensor_select", "internal", meta);

            expect(writeFn).toHaveBeenCalledWith("customSonoffSnzb02dr2", {temperatureSensorSelect: 0}, undefined);
        });

        it("writes external temperature scaled x100 (signed)", async () => {
            const tzConverter = device.toZigbee.find((c) => c.key.includes("external_temperature"));

            await tzConverter.convertSet(endpoint, "external_temperature", -10.07, meta);

            expect(writeFn).toHaveBeenCalledWith("customSonoffSnzb02dr2", {externalTemperature: -1007}, undefined);
        });

        it("writes external humidity scaled x100", async () => {
            const tzConverter = device.toZigbee.find((c) => c.key.includes("external_humidity"));

            await tzConverter.convertSet(endpoint, "external_humidity", 88, meta);

            expect(writeFn).toHaveBeenCalledWith("customSonoffSnzb02dr2", {externalHumidity: 8800}, undefined);
        });
    });
});

describe("Sonoff SWV-ZFE", () => {
    let device: Definition;
    let endpoint: ZHModels.Endpoint;
    let writeFn: Mock;
    let commandFn: Mock;
    let meta: Tz.Meta;

    beforeEach(async () => {
        device = await findByDevice(mockDevice({modelID: "SWV-ZFE", endpoints: [{ID: 1}]}));

        writeFn = vi.fn();
        commandFn = vi.fn();
        endpoint = {write: writeFn, command: commandFn} as unknown as ZHModels.Endpoint;
        meta = {
            state: {
                irrigation_duration: 15,
                irrigation_mode: "capacity",
                irrigation_amount_unit: "liter",
                irrigation_amount: 42,
                fail_safe: 60,
                seasonal_watering_adjustment: {
                    january: 1.1,
                    february: 1.2,
                    march: 1.3,
                    april: 1.4,
                    may: 1.5,
                    june: 1.6,
                    july: 1.7,
                    august: 1.8,
                    september: 1.9,
                    october: 2,
                    november: 0.9,
                    december: 0.8,
                },
                valve_alarm_settings: {
                    enable_alarm_water_shortage: true,
                    enable_alarm_water_leak: false,
                    enable_water_shortage_auto_close: true,
                    alarm_water_shortage_duration: 5,
                    alarm_water_leak_duration: 1,
                },
                irrigation_plan_report: {
                    plan_index: 2,
                    enable_state: true,
                    loop_type_mode: "weekdays",
                    loop_type_interval_days: 1,
                    loop_type_week_days: {
                        sunday: true,
                        monday: false,
                        tuesday: true,
                        wednesday: false,
                        thursday: true,
                        friday: false,
                        saturday: false,
                    },
                    enable_date: "2026-06-21",
                    start_time: "06:30",
                    irrigation_mode: "capacity",
                    irrigation_total_duration: 20,
                    irrigation_duration: 4,
                    interval_duration: 3,
                    irrigation_amount_unit: "liter",
                    irrigation_amount: 50,
                    fail_safe: 30,
                    create_datetime: "2026-06-21T04:30:00Z",
                },
            },
            device: null,
            message: null,
            mapped: null,
            options: null,
            publish: null,
            endpoint_name: null,
        };
    });

    it("exposes manual irrigation settings as scalar controls", () => {
        const exposes =
            typeof device.exposes === "function" ? device.exposes(mockDevice({modelID: "SWV-ZFE", endpoints: [{ID: 1}]}), {}) : device.exposes;
        const names = exposes.map((expose) => expose.property);

        expect(names).toContain("irrigation_duration");
        expect(names).toContain("irrigation_mode");
        expect(names).toContain("irrigation_amount_unit");
        expect(names).toContain("irrigation_amount");
        expect(names).toContain("fail_safe");
    });

    it("hides manual amount unit on firmware with unified water-flow units", () => {
        const newFirmwareDevice = mockDevice({modelID: "SWV-ZFE", softwareBuildID: "1.1.0", endpoints: [{ID: 1}]});
        const exposes = typeof device.exposes === "function" ? device.exposes(newFirmwareDevice, {}) : device.exposes;
        const names = exposes.map((expose) => expose.property);

        expect(names).not.toContain("irrigation_amount_unit");
    });

    it("uses the unified water-flow unit instead of a stale legacy unit", async () => {
        const newFirmwareDevice = mockDevice({modelID: "SWV-ZFE", softwareBuildID: "1.1.0", endpoints: [{ID: 1}]});
        const tzConverter = device.toZigbee.find((converter) => converter.key.includes("irrigation_duration"));
        const result = await tzConverter.convertSet(endpoint, "irrigation_duration", 30, {
            ...meta,
            device: newFirmwareDevice,
            state: {
                irrigation_duration: 15,
                irrigation_mode: "capacity",
                irrigation_amount_unit: "liter",
                irrigation_amount: 3,
                fail_safe: 60,
                water_flow_unit: "us_gallon",
            },
        });

        expect(writeFn).toHaveBeenCalledWith(
            "customClusterEwelink",
            {
                20509: {
                    value: {
                        elementType: 0x20,
                        elements: new Uint8Array([1, 0, 30, 0, 30, 0, 10, 0, 0, 3, 0, 60]),
                    },
                    type: 0x48,
                },
            },
            {},
        );
        expect(result).toMatchObject({state: {irrigation_amount: 3}});
    });

    it("preserves the real liter amount when an OTA-updated device first reports its unified unit", () => {
        const newFirmwareDevice = mockDevice({modelID: "SWV-ZFE", softwareBuildID: "1.1.0", endpoints: [{ID: 1}]});
        const message = {
            data: {unitOfWaterFlow: 1},
            endpoint: endpoint,
            device: newFirmwareDevice,
            meta: {},
            groupID: 0,
            type: "attributeReport" as const,
        };
        const converterMeta = {
            state: {
                irrigation_amount_unit: "liter",
                irrigation_amount: 10,
            },
            device: newFirmwareDevice,
            deviceExposesChanged: null,
        };
        const fzConverter = device.fromZigbee.find(
            (converter) => converter.convert(device, message, vi.fn(), {}, converterMeta)?.water_flow_unit !== undefined,
        );
        const result = fzConverter.convert(device, message, vi.fn(), {}, converterMeta);

        expect(result).toEqual({
            water_flow_unit: "us_gallon",
            irrigation_amount: 3,
            irrigation_amount_real_liter: 10,
            irrigation_amount_unit: null,
        });
    });

    it("uses the real liter amount for every later water-flow unit change", async () => {
        const newFirmwareDevice = mockDevice({modelID: "SWV-ZFE", softwareBuildID: "1.1.0", endpoints: [{ID: 1}]});
        const tzConverter = device.toZigbee.find((converter) => converter.key.includes("water_flow_unit"));
        const result = await tzConverter.convertSet(endpoint, "water_flow_unit", "imperial_gallon", {
            ...meta,
            device: newFirmwareDevice,
            state: {
                water_flow_unit: "us_gallon",
                irrigation_amount: 3,
                irrigation_amount_real_liter: 10,
            },
        });

        expect(result).toEqual({
            state: {
                water_flow_unit: "imperial_gallon",
                irrigation_amount: 2,
                irrigation_amount_real_liter: 10,
            },
        });
    });

    it("does not clear a legacy amount unit when the reported unit is unchanged", () => {
        const newFirmwareDevice = mockDevice({modelID: "SWV-ZFE", softwareBuildID: "1.1.0", endpoints: [{ID: 1}]});
        const message = {
            data: {unitOfWaterFlow: 1},
            endpoint,
            device: newFirmwareDevice,
            meta: {},
            groupID: 0,
            type: "attributeReport" as const,
        };
        const converterMeta = {
            state: {
                irrigation_amount_unit: "us_gallon",
                irrigation_amount: 3,
            },
            device: newFirmwareDevice,
            deviceExposesChanged: null,
        };
        const fzConverter = device.fromZigbee.find(
            (converter) => converter.convert(device, message, vi.fn(), {}, converterMeta)?.water_flow_unit !== undefined,
        );
        const result = fzConverter.convert(device, message, vi.fn(), {}, converterMeta);

        expect(result).toEqual({water_flow_unit: "us_gallon"});
    });

    it("does not clear a legacy amount unit when setting the same unit", async () => {
        const newFirmwareDevice = mockDevice({modelID: "SWV-ZFE", softwareBuildID: "1.1.0", endpoints: [{ID: 1}]});
        const tzConverter = device.toZigbee.find((converter) => converter.key.includes("water_flow_unit"));
        const result = await tzConverter.convertSet(endpoint, "water_flow_unit", "us_gallon", {
            ...meta,
            device: newFirmwareDevice,
            state: {
                water_flow_unit: "us_gallon",
                irrigation_amount_unit: "us_gallon",
                irrigation_amount: 3,
            },
        });

        expect(result).toEqual({state: {water_flow_unit: "us_gallon"}});
    });

    it("merges a scalar manual setting with current scalar state", async () => {
        const tzConverter = device.toZigbee.find((converter) => converter.key.includes("irrigation_duration"));

        const result = await tzConverter.convertSet(endpoint, "irrigation_duration", 30, meta);

        expect(writeFn).toHaveBeenCalledWith(
            "customClusterEwelink",
            {
                20509: {
                    value: {
                        elementType: 0x20,
                        elements: new Uint8Array([1, 0, 30, 0, 30, 0, 10, 1, 0, 42, 0, 60]),
                    },
                    type: 0x48,
                },
            },
            {},
        );
        expect(result).toMatchObject({
            state: {
                irrigation_duration: 30,
                irrigation_mode: "capacity",
                irrigation_amount_unit: "liter",
                irrigation_amount: 42,
                fail_safe: 60,
            },
        });
    });

    describe("toZigbee", () => {
        it("fills missing scalar settings with defaults on first write", async () => {
            const tzConverter = device.toZigbee.find((c) => c.key.includes("irrigation_duration"));
            const result = await tzConverter.convertSet(endpoint, "irrigation_duration", 30, {...meta, state: {}});

            expect(writeFn).toHaveBeenCalledWith(
                "customClusterEwelink",
                {
                    20509: {
                        value: {
                            elementType: 0x20,
                            elements: new Uint8Array([0, 0, 30, 0, 30, 0, 10, 1, 0, 0, 0, 0]),
                        },
                        type: 0x48,
                    },
                },
                {},
            );
            expect(result).toEqual({
                state: {
                    irrigation_duration: 30,
                    irrigation_mode: "duration",
                    irrigation_amount_unit: "liter",
                    irrigation_amount: 0,
                    fail_safe: 0,
                },
            });
        });

        it("sends seasonal watering adjustment to device", async () => {
            const tzConverter = device.toZigbee.find((c) => c.key.includes("seasonal_watering_adjustment"));

            const value = {
                january: 1.1,
                february: 1.2,
                march: 1.3,
                april: 1.4,
                may: 1.5,
                june: 0.7,
                july: 1.7,
                august: 1.8,
                september: 1.9,
                october: 2,
                november: 0.9,
                december: 0.8,
            };
            const result = await tzConverter.convertSet(endpoint, "seasonal_watering_adjustment", value, meta);

            expect(writeFn).toHaveBeenCalledWith(
                "customClusterEwelink",
                {
                    20510: {
                        value: {
                            elementType: 0x20,
                            elements: new Uint8Array([11, 12, 13, 14, 15, 7, 17, 18, 19, 20, 9, 8]),
                        },
                        type: 0x48,
                    },
                },
                {},
            );
            expect(result).toEqual({
                state: {
                    seasonal_watering_adjustment: value,
                },
            });
        });

        it("sends valve alarm settings to device", async () => {
            const tzConverter = device.toZigbee.find((c) => c.key.includes("valve_alarm_settings"));

            const value = {
                enable_alarm_water_shortage: true,
                enable_alarm_water_leak: false,
                enable_water_shortage_auto_close: true,
                alarm_water_shortage_duration: 5,
                alarm_water_leak_duration: 3,
            };
            const result = await tzConverter.convertSet(endpoint, "valve_alarm_settings", value, meta);

            expect(writeFn).toHaveBeenCalledWith(
                "customClusterEwelink",
                {
                    20512: {
                        value: {
                            elementType: 0x20,
                            elements: new Uint8Array([0b01001, 5, 3, 0]),
                        },
                        type: 0x48,
                    },
                },
                {},
            );
            expect(result).toEqual({
                state: {
                    valve_alarm_settings: value,
                },
            });
        });

        it("sends irrigation plan settings to device", async () => {
            const tzConverter = device.toZigbee.find((c) => c.key.includes("irrigation_plan_settings"));
            const year2000InUtc = 946684800;
            const enableDate = Date.UTC(2026, 5, 21, 0, 0, 0) / 1000 - year2000InUtc;
            const createDatetime = Date.parse("2026-06-21T04:30:00Z") / 1000;
            const expectedPayload = [
                2,
                1,
                3,
                0b00010101,
                (enableDate >> 24) & 0xff,
                (enableDate >> 16) & 0xff,
                (enableDate >> 8) & 0xff,
                enableDate & 0xff,
                1,
                0,
                0,
                91,
                104,
                0,
                20,
                0,
                9,
                0,
                3,
                1,
                0,
                50,
                0,
                30,
                (createDatetime >> 24) & 0xff,
                (createDatetime >> 16) & 0xff,
                (createDatetime >> 8) & 0xff,
                createDatetime & 0xff,
            ];

            const value = {
                plan_index: 2,
                enable_state: true,
                loop_type_mode: "weekdays",
                loop_type_interval_days: 1,
                loop_type_week_days: {
                    sunday: true,
                    monday: false,
                    tuesday: true,
                    wednesday: false,
                    thursday: true,
                    friday: false,
                    saturday: false,
                },
                enable_date: "2026-06-21",
                start_time: "06:30",
                irrigation_mode: "capacity",
                irrigation_total_duration: 20,
                irrigation_duration: 9,
                interval_duration: 3,
                irrigation_amount_unit: "liter",
                irrigation_amount: 50,
                fail_safe: 30,
                create_datetime: "2026-06-21T04:30:00Z",
            };
            const result = await tzConverter.convertSet(endpoint, "irrigation_plan_settings", value, meta);

            expect(commandFn).toHaveBeenCalledWith(
                "customClusterEwelink",
                "irrigationPlanSettings",
                {data: expectedPayload},
                {disableDefaultResponse: false},
            );
            expect(result).toEqual({
                state: {
                    irrigation_plan_settings: value,
                },
            });
        });

        it("removes an irrigation plan through the composite remove command", async () => {
            const tzConverter = device.toZigbee.find((c) => c.key.includes("irrigation_plan_remove"));

            const result = await tzConverter.convertSet(endpoint, "irrigation_plan_remove", {plan_index: 3}, meta);

            expect(commandFn).toHaveBeenCalledWith("customClusterEwelink", "irrigationPlanRemove", {data: [3]}, {disableDefaultResponse: true});
            expect(result).toEqual({
                state: {
                    irrigation_plan_remove: {plan_index: 3},
                    irrigation_plan_settings_3: null,
                },
            });
        });
    });
});

describe("Sonoff firmware-dependent features", () => {
    const dummyDevice: DummyDevice = {isDummyDevice: true};
    let sequenceNumber = 0;
    const getExposes = (definition: Definition, device: ZHModels.Device | DummyDevice) =>
        typeof definition.exposes === "function" ? definition.exposes(device, {}) : definition.exposes;
    const getProperties = (definition: Definition, device: ZHModels.Device | DummyDevice) =>
        getExposes(definition, device).map((expose) => expose.property);
    const getEnumValues = (definition: Definition, device: ZHModels.Device | DummyDevice, property: string) => {
        const expose = getExposes(definition, device).find((item) => item.property === property);
        expect(expose).toBeInstanceOf(Enum);
        return (expose as Enum).values;
    };
    const convertMessage = async (
        definition: Definition,
        device: ZHModels.Device,
        data: KeyValue,
        type = "attributeReport",
        cluster = "customClusterEwelink",
    ) => {
        const message = {
            data,
            device,
            endpoint: device.getEndpoint(1),
            cluster,
            type,
            meta: {rawData: Buffer.alloc(0), zclTransactionSequenceNumber: sequenceNumber++},
            groupID: 0,
            linkquality: 100,
        } as Parameters<Definition["fromZigbee"][number]["convert"]>[1];
        const result: KeyValue = {};
        for (const converter of definition.fromZigbee) {
            if (converter.cluster === cluster && converter.type.includes(type)) {
                Object.assign(result, await converter.convert(definition, message, vi.fn(), {}, {device, state: {}, deviceExposesChanged: vi.fn()}));
            }
        }
        return result;
    };

    describe("BASIC-ZB1GSP", () => {
        it.each([
            {softwareBuildID: "1.3.1", legacyReporting: false, legacyHistory: false, outputEnergy: true},
            {softwareBuildID: "1.0.4", legacyReporting: true, legacyHistory: true, outputEnergy: false},
            {softwareBuildID: "1.0.5", legacyReporting: false, legacyHistory: true, outputEnergy: false},
            {softwareBuildID: "1.0.6", legacyReporting: false, legacyHistory: true, outputEnergy: false},
            {softwareBuildID: "1.2.9", legacyReporting: false, legacyHistory: true, outputEnergy: false},
            {softwareBuildID: "1.3.0", legacyReporting: false, legacyHistory: false, outputEnergy: true},
            {softwareBuildID: "1.3", legacyReporting: false, legacyHistory: false, outputEnergy: true},
            {softwareBuildID: "1.10.0", legacyReporting: false, legacyHistory: false, outputEnergy: true},
            {softwareBuildID: undefined, legacyReporting: false, legacyHistory: false, outputEnergy: false},
        ])("selects exposes, initial reads and reporting for $softwareBuildID", async ({
            softwareBuildID,
            legacyReporting,
            legacyHistory,
            outputEnergy,
        }) => {
            const device = mockDevice({modelID: "BASIC-ZB1GSP", softwareBuildID, endpoints: [{ID: 1, inputClusterIDs: [6, 0xfc11, 0x0702]}]});
            const definition = await findByDevice(device);
            const properties = getProperties(definition, device);
            expect(properties).toEqual(expect.arrayContaining(["energy_today", "energy_month", "energy_yesterday", "total_energy"]));
            expect(properties.includes("read_consumption_records")).toBe(legacyHistory);
            for (const property of [
                "output_energy_today",
                "output_energy_month",
                "total_output_energy",
                "read_electricity_records",
                "read_all_electricity_records",
            ]) {
                expect(properties.includes(property), property).toBe(outputEnergy);
            }

            await definition.configure(device, mockDevice({modelID: "coordinator", endpoints: [{ID: 1}]}).getEndpoint(1), definition);
            const endpoint = device.getEndpoint(1);
            const onOffReporting = vi.mocked(endpoint.configureReporting).mock.calls.filter(([cluster]) => cluster === "genOnOff");
            expect(onOffReporting).toHaveLength(legacyReporting ? 1 : 0);
            if (legacyReporting) {
                expect(onOffReporting[0][1]).toEqual([
                    {attribute: "onOff", minimumReportInterval: 0, maximumReportInterval: 65000, reportableChange: 1},
                ]);
            }
            const readCalls = vi.mocked(endpoint.read).mock.calls as [string, (string | number)[], unknown?][];
            const initialRead = readCalls.find(([cluster, attributes]) => cluster === "customClusterEwelink" && attributes.includes("energyToday"));
            expect(initialRead).toBeDefined();
            for (const attribute of ["outputEnergyToday", "outputEnergyMonth", "totalOutputEnergyConsumption"]) {
                expect(initialRead[1].includes(attribute), attribute).toBe(outputEnergy);
            }
        });

        it("hides firmware-dependent controls on dummy devices under the existing policy", async () => {
            const definition = await findByDevice(mockDevice({modelID: "BASIC-ZB1GSP", endpoints: [{ID: 1}]}));
            const properties = getProperties(definition, dummyDevice);
            expect(properties).toContain("total_energy");
            for (const property of ["read_consumption_records", "read_electricity_records", "total_output_energy"])
                expect(properties).not.toContain(property);
        });
    });

    describe("SNZB-02DR2", () => {
        const legacyProperties = ["temperature_sensor_select", "external_temperature", "external_humidity"];
        const remoteProperties = [
            "remote_source_status",
            "source_1_temperature",
            "source_1_temperature_state",
            "source_1_humidity",
            "source_1_humidity_state",
            "source_2_temperature",
            "source_2_temperature_state",
            "source_2_humidity",
            "source_2_humidity_state",
        ];
        it.each([
            {softwareBuildID: "1.0.4", legacy: true, remote: false},
            {softwareBuildID: "1.0.5", legacy: false, remote: true},
            {softwareBuildID: "1.0.6", legacy: false, remote: true},
            {softwareBuildID: undefined, legacy: false, remote: false},
        ])("selects the display controls for $softwareBuildID", async ({softwareBuildID, legacy, remote}) => {
            const device = mockDevice({modelID: "SNZB-02DR2", softwareBuildID, endpoints: [{ID: 1}]});
            const definition = await findByDevice(device);
            const properties = getProperties(definition, device);
            expect(properties).toEqual(expect.arrayContaining(["temperature", "humidity", "comfort_temperature_min"]));
            for (const property of legacyProperties) expect(properties.includes(property), property).toBe(legacy);
            for (const property of remoteProperties) expect(properties.includes(property), property).toBe(remote);
        });

        it("hides firmware-dependent display controls on dummy devices under the existing policy", async () => {
            const definition = await findByDevice(mockDevice({modelID: "SNZB-02DR2", endpoints: [{ID: 1}]}));
            const properties = getProperties(definition, dummyDevice);
            expect(properties).toEqual(expect.arrayContaining(["temperature", "humidity"]));
            for (const property of [...legacyProperties, ...remoteProperties]) expect(properties).not.toContain(property);
        });
    });

    describe("ZBMINIR2 and MINI-ZBD", () => {
        const devices = [
            {modelID: "ZBMINIR2", softwareBuildID: "1.0.9", newActions: false},
            {modelID: "ZBMINIR2", softwareBuildID: "1.1.0", newActions: true},
            {modelID: "ZBMINIR2", softwareBuildID: "1.1.1", newActions: true},
            {modelID: "ZBMINIR2", softwareBuildID: undefined, newActions: false},
            {modelID: "MINI-ZBD", softwareBuildID: "1.0.9", newActions: false},
            {modelID: "MINI-ZBD", softwareBuildID: "1.1.0", newActions: false},
            {modelID: "MINI-ZBD", softwareBuildID: "9.0.0", newActions: false},
        ];
        it.each(devices)("selects action exposes for $modelID $softwareBuildID", async ({modelID, softwareBuildID, newActions}) => {
            const device = mockDevice({modelID, manufacturerName: "SONOFF", softwareBuildID, endpoints: [{ID: 1}]});
            const definition = await findByDevice(device);
            expect(definition.model).toBe(modelID);
            expect(getEnumValues(definition, device, "action")).toEqual(newActions ? ["toggle", "double_click", "long_press"] : ["toggle"]);
        });
        it.each(devices)("gates new action reports and preserves toggle for $modelID $softwareBuildID", async ({
            modelID,
            softwareBuildID,
            newActions,
        }) => {
            const device = mockDevice({modelID, manufacturerName: "SONOFF", softwareBuildID, endpoints: [{ID: 1}]});
            const definition = await findByDevice(device);
            expect(definition.model).toBe(modelID);
            expect(await convertMessage(definition, device, {detachRelayActionEvent: 2})).toEqual(newActions ? {action: "double_click"} : {});
            expect(await convertMessage(definition, device, {detachRelayActionEvent: 3})).toEqual(newActions ? {action: "long_press"} : {});
            expect(await convertMessage(definition, device, {detachRelayActionEvent: 99})).toEqual({});
            expect(await convertMessage(definition, device, {})).toEqual({});
            expect(await convertMessage(definition, device, {}, "commandToggle", "genOnOff")).toEqual({action: "toggle"});
        });

        it("includes all supported actions in documentation", async () => {
            const definition = await findByDevice(mockDevice({modelID: "ZBMINIR2", endpoints: [{ID: 1}]}));
            expect(getEnumValues(definition, dummyDevice, "action")).toEqual(["toggle", "double_click", "long_press"]);
        });
    });

    describe("SNZB-09P", () => {
        const baseSounds = [
            "siren_classic",
            "siren_steady",
            "siren_rising",
            "siren_warning",
            "siren_rapid",
            "siren_emergency",
            "tone_chirp",
            "tone_hi_lo",
            "tone_intermittent",
            "tone_pulse",
        ];
        const chimeSounds = ["chime_doorbell", "chime_classic_clock", "chime_electronic_clock", "chime_bright", "chime_soft"];
        it.each([
            {softwareBuildID: "1.1.8", supported: false},
            {softwareBuildID: "1.1.9", supported: true},
            {softwareBuildID: "1.1.10", supported: true},
            {softwareBuildID: undefined, supported: false},
        ])("selects sounds and startup reads for $softwareBuildID", async ({softwareBuildID, supported}) => {
            const device = mockDevice({modelID: "SNZB-09P", softwareBuildID, endpoints: [{ID: 1}]});
            const definition = await findByDevice(device);
            expect(getEnumValues(definition, device, "alarm_sound_type")).toEqual(supported ? [...baseSounds, ...chimeSounds] : baseSounds);
            const endpoint = device.getEndpoint(1);
            vi.mocked(endpoint.read).mockImplementation(() => {
                expect(device.customClusters.customClusterEwelink.attributes.alarmStatus.ID).toBe(0x202e);
                return Promise.resolve({});
            });
            await definition.onEvent({type: "start", data: {device, state: {}, options: {}, deviceExposesChanged: vi.fn()}});
            expect(endpoint.read).toHaveBeenCalledTimes(supported ? 1 : 0);
            if (supported) {
                expect(endpoint.read).toHaveBeenCalledWith("customClusterEwelink", ["alarmStatus"], {
                    manufacturerCode: 0x1286,
                    disableDefaultResponse: false,
                });
            } else {
                for (const type of ["deviceJoined", "deviceAnnounce", "deviceInterview"] as const) {
                    await definition.onEvent({
                        type,
                        data: {device, state: {}, options: {}, deviceExposesChanged: vi.fn(), status: "successful"},
                    } as OnEvent.Event);
                }
                expect(endpoint.read).not.toHaveBeenCalled();
            }
        });

        it("filters a cloned enum without contaminating other devices or documentation", async () => {
            const oldDevice = mockDevice({modelID: "SNZB-09P", softwareBuildID: "1.1.8", endpoints: [{ID: 1}]});
            const newDevice = mockDevice({modelID: "SNZB-09P", softwareBuildID: "1.1.9", endpoints: [{ID: 1}]});
            const definition = await findByDevice(newDevice);
            const completeValues = [...baseSounds, ...chimeSounds];
            expect(getEnumValues(definition, newDevice, "alarm_sound_type")).toEqual(completeValues);
            expect(getEnumValues(definition, oldDevice, "alarm_sound_type")).toEqual(baseSounds);
            expect(getEnumValues(definition, dummyDevice, "alarm_sound_type")).toEqual(completeValues);
            expect(getEnumValues(definition, oldDevice, "alarm_sound_type")).toEqual(baseSounds);
            expect(getEnumValues(definition, newDevice, "alarm_sound_type")).toEqual(completeValues);
        });

        it.each(["deviceJoined", "deviceAnnounce", "deviceInterview"] as const)("refreshes alarm status on %s after startup", async (type) => {
            const device = mockDevice({modelID: "SNZB-09P", softwareBuildID: "1.1.9", endpoints: [{ID: 1}]});
            const definition = await findByDevice(device);
            const data = {device, state: {}, options: {}, deviceExposesChanged: vi.fn()};
            await definition.onEvent({type: "start", data});
            vi.mocked(device.getEndpoint(1).read).mockClear();
            await definition.onEvent({type, data: {...data, status: "successful"}} as OnEvent.Event);
            expect(device.getEndpoint(1).read).toHaveBeenCalledExactlyOnceWith("customClusterEwelink", ["alarmStatus"], {
                manufacturerCode: 0x1286,
                disableDefaultResponse: false,
            });
        });

        it("ignores unrelated events and tolerates a sleeping device", async () => {
            const device = mockDevice({modelID: "SNZB-09P", softwareBuildID: "1.1.9", endpoints: [{ID: 1}]});
            const definition = await findByDevice(device);
            const data = {device, state: {}, options: {}, deviceExposesChanged: vi.fn()};
            await definition.onEvent({type: "start", data});
            const endpoint = device.getEndpoint(1);
            vi.mocked(endpoint.read).mockClear();
            await definition.onEvent({type: "deviceNetworkAddressChanged", data});
            expect(endpoint.read).not.toHaveBeenCalled();
            vi.mocked(endpoint.read).mockRejectedValueOnce(new Error("Device is sleeping"));
            await expect(definition.onEvent({type: "deviceAnnounce", data})).resolves.toBeUndefined();
            expect(endpoint.read).toHaveBeenCalledTimes(1);
        });

        it.each([
            {status: 0, alarmType: "none", siren: "OFF"},
            {status: 1, alarmType: "manual", siren: "ON"},
            {status: 2, alarmType: "scene", siren: "ON"},
        ])("parses reported and read alarm status $status", async ({status, alarmType, siren}) => {
            const device = mockDevice({modelID: "SNZB-09P", softwareBuildID: "1.1.9", endpoints: [{ID: 1}]});
            const definition = await findByDevice(device);
            for (const type of ["attributeReport", "readResponse"]) {
                expect(await convertMessage(definition, device, {alarmStatus: status}, type)).toEqual({alarm_type: alarmType, siren_on: siren});
            }
            expect(await convertMessage(definition, device, {alarmStatus: 3})).toEqual({});
            expect(await convertMessage(definition, device, {alarmStatus: "1"})).toEqual({});
            expect(await convertMessage(definition, device, {})).toEqual({});
        });
    });
});
