import mqtt from "mqtt";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "fs";

// --- Main Configuration ---
const MQTT_BROKER_URL = process.env.MQTT_BROKER_URL || "mqtt://localhost:1883";
const MQTT_TOPIC = process.env.MQTT_TOPIC || "nodes/#";
const BATCH_INTERVAL_MS = 60 * 1000;

// --- Alerting Thresholds ---
const TEMP_CRITICAL_THRESHOLD = 80.0; // In Celsius
const TEMP_WARNING_THRESHOLD = 60.0; // In Celsius
const TEMP_SUDDEN_CHANGE_THRESHOLD = 10.0; // In Celsius
const VOLTAGE_UNBALANCE_THRESHOLD = 3.0; // In percent
const CURRENT_UNBALANCE_THRESHOLD = 15.0; // In percent
const NEUTRAL_CURRENT_FACTOR_THRESHOLD = 0.5; // Neutral current as a factor of average phase current
const NEUTRAL_CURRENT_MIN_PHASE_AMPS = 1.0; // Minimum average phase amps to trigger neutral current check
const POWER_FACTOR_THRESHOLD = 0.85; // Lower limit for power factor
const CREST_FACTOR_THRESHOLD = 2.0; // Upper limit for crest factor

// --- Outlier Detection Configuration ---
const OUTLIER_Z_SCORE_THRESHOLD = 3.0;
const OUTLIER_MIN_SAMPLES = 20;
const OUTLIER_HISTORY_MAX_SIZE = 43200; // Roughly 1 month of 1-minute aggregates per hour slot

// --- Environment Variable Loading ---
const endpoint0Url = process.env.ENDPOINT0_URL;
const endpoint0Token = process.env.ENDPOINT0_TOKEN;
const endpoint1Url = process.env.ENDPOINT1_URL;
const endpoint1Token = process.env.ENDPOINT1_TOKEN;

// --- Database Setup ---
if (!existsSync("./db")) {
	mkdirSync("./db");
}
const db = new Database("./db/node_stats.sqlite");
db.exec("PRAGMA journal_mode = WAL;");
db.exec(`
  CREATE TABLE IF NOT EXISTS electrical_history (
    node_id TEXT NOT NULL,
    metric TEXT NOT NULL,
    hour INTEGER NOT NULL,
    value REAL NOT NULL,
    timestamp INTEGER NOT NULL PRIMARY KEY
  );
`);
db.exec(
	"CREATE INDEX IF NOT EXISTS idx_electrical_history ON electrical_history (node_id, metric, hour);",
);

// --- In-Memory Storage ---
const nodeMemoryStore: {
	[nodeId: string]: { lastTemperature: number | null };
} = {};
const dataBuffer: {
	[nodeId: string]: {
		[metricName: string]: { value: number; timestamp: number }[];
	};
} = {};
const lastApiPostTime: { [nodeId: string]: number } = {};
const latestNodePayload: { [nodeId: string]: any } = {};

// --- Helper Functions ---
async function postToApi(url: string, token: string, data: any) {
	if (!url || !token) {
		console.error("API URL or token is not defined. Check your .env file.");
		return;
	}
	try {
		const response = await fetch(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${token}`,
			},
			body: JSON.stringify(data),
		});
		if (!response.ok) {
			console.error(
				`API request to ${url} failed with status: ${response.status} ${await response.text()}`,
			);
		}
	} catch (error) {
		console.error(`Error posting to API:`, error);
	}
}
function calculateVoltageUnbalance(voltages: {
	[key: string]: { rms: number };
}): number {
	const v_rms = [
		voltages["1"]?.rms,
		voltages["2"]?.rms,
		voltages["3"]?.rms,
	].filter((v) => v !== undefined) as number[];
	if (v_rms.length < 3) return 0;
	const avgVoltage = v_rms.reduce((s, v) => s + v, 0) / 3;
	if (avgVoltage === 0) return 0;
	const maxDeviation = Math.max(...v_rms.map((v) => Math.abs(v - avgVoltage)));
	return (maxDeviation / avgVoltage) * 100;
}
function calculateCurrentUnbalance(circuits: {
	[key: string]: { current: { rms: number } };
}): number {
	const i_rms = [circuits["1"], circuits["2"], circuits["3"]]
		.map((c) => c?.current?.rms)
		.filter((i) => i !== undefined) as number[];
	if (i_rms.length < 3 || i_rms.every((i) => i === 0)) return 0;
	const avgCurrent = i_rms.reduce((s, i) => s + i, 0) / 3;
	if (avgCurrent === 0) return 0;
	const maxDeviation = Math.max(...i_rms.map((i) => Math.abs(i - avgCurrent)));
	return (maxDeviation / avgCurrent) * 100;
}

// --- Scalable Outlier Detection ---
const queryGetStats = db.query<
	{ count: number; mean: number; stdDev: number },
	[string, string, number]
>(
	`SELECT COUNT(value) as count, AVG(value) as mean, SQRT(AVG(value * value) - AVG(value) * AVG(value)) as stdDev FROM electrical_history WHERE node_id = ? AND metric = ? AND hour = ?`,
);
const queryInsertHistory = db.query<
	null,
	[string, string, number, number, number]
>(
	"INSERT INTO electrical_history (node_id, metric, hour, value, timestamp) VALUES (?, ?, ?, ?, ?)",
);
const queryDeleteOldest = db.query<null, [string, string, number]>(
	"DELETE FROM electrical_history WHERE timestamp = (SELECT MIN(timestamp) FROM electrical_history WHERE node_id = ? AND metric = ? AND hour = ?)",
);

function checkAggregateForOutlier(
	nodeId: string,
	metricName: string,
	aggregateValue: number,
	timestamp: number,
): { isOutlier: boolean; reason?: string } {
	const hour = new Date(timestamp * 1000).getUTCHours();
	const stats = queryGetStats.get(nodeId, metricName, hour);
	let isOutlier = false;
	let reason = "";
	if (stats && stats.count >= OUTLIER_MIN_SAMPLES && stats.stdDev > 0) {
		const { mean, stdDev } = stats;
		const zScore = Math.abs((aggregateValue - mean) / stdDev);
		if (zScore > OUTLIER_Z_SCORE_THRESHOLD) {
			isOutlier = true;
			reason = `${metricName} 1-min avg ${aggregateValue.toFixed(2)} has a Z-score of ${zScore.toFixed(2)}, exceeding threshold. (Monthly Mean: ${mean.toFixed(2)}, StdDev: ${stdDev.toFixed(2)})`;
		}
	}
	db.transaction(() => {
		queryInsertHistory.run(
			nodeId,
			metricName,
			hour,
			aggregateValue,
			timestamp,
		);
		const totalCount = (stats?.count ?? 0) + 1;
		if (totalCount > OUTLIER_HISTORY_MAX_SIZE) {
			queryDeleteOldest.run(nodeId, metricName, hour);
		}
	})();
	return { isOutlier, reason };
}

// --- Batch Processor ---
async function flushBufferAndSendHeartbeat() {
	const nodesToProcess = Object.keys(latestNodePayload);

	for (const nodeId of nodesToProcess) {
		const outlierReasons: string[] = [];
		if (dataBuffer[nodeId]) {
			for (const metricName in dataBuffer[nodeId]) {
				const readings = dataBuffer[nodeId][metricName];
				if (readings.length === 0) continue;
				const averageValue =
					readings.reduce((sum, r) => sum + r.value, 0) / readings.length;
				const lastTimestamp = readings[readings.length - 1].timestamp;
				const outlierResult = checkAggregateForOutlier(
					nodeId,
					metricName,
					averageValue,
					lastTimestamp,
				);
				if (outlierResult.isOutlier && outlierResult.reason) {
					outlierReasons.push(outlierResult.reason);
				}
			}
			dataBuffer[nodeId] = {};
		}

		if (outlierReasons.length > 0) {
			console.log(
				"STATISTICAL OUTLIER DETECTED:",
				outlierReasons.join("; "),
			);
			const payloadToPost = latestNodePayload[nodeId];
			if (payloadToPost) {
				payloadToPost.flags.statisticalOutlierDetected = outlierReasons;
				await postToApi(endpoint0Url!, endpoint0Token!, payloadToPost);
				await postToApi(endpoint1Url!, endpoint1Token!, payloadToPost);
				lastApiPostTime[nodeId] = Date.now();
			}
		}

		const lastPost = lastApiPostTime[nodeId] || 0;
		if (Date.now() - lastPost >= BATCH_INTERVAL_MS) {
			console.log(
				`[${new Date().toISOString()}] No flags for node ${nodeId} in the last minute. Sending periodic update.`,
			);
			const latestPayload = latestNodePayload[nodeId];
			if (latestPayload) {
				await postToApi(endpoint0Url!, endpoint0Token!, latestPayload);
				await postToApi(endpoint1Url!, endpoint1Token!, latestPayload);
				lastApiPostTime[nodeId] = Date.now();
			}
		}
	}
}

setInterval(flushBufferAndSendHeartbeat, BATCH_INTERVAL_MS);

// --- MQTT Client ---
console.log("Connecting to MQTT broker...");
const client = mqtt.connect(MQTT_BROKER_URL);

client.on("connect", () => {
	console.log("Successfully connected to MQTT broker");
	client.subscribe(MQTT_TOPIC, (err) => {
		if (err) console.error("Subscription error:", err);
		else console.log(`Subscribed to topic: ${MQTT_TOPIC}`);
	});
});

// --- Message Handler ---
client.on("message", async (topic, message) => {
	try {
		const payload = JSON.parse(message.toString());
		const topicParts = topic.split("/");
		if (topicParts.length < 4) return;
		const nodeId = topicParts[1];
		const dataType = topicParts[2];
		if (!nodeMemoryStore[nodeId])
			nodeMemoryStore[nodeId] = { lastTemperature: null };

		const processedData: any = {
			topic,
			data: payload,
			nodeId,
			timestamp: payload.timestamp,
			flags: {},
			calculatedMetrics: {},
		};

		if (dataType === "thermal") {
			const tempTransformer = payload.data.channels.a.temperature;
			if (tempTransformer > TEMP_CRITICAL_THRESHOLD)
				processedData.flags.highTemperatureAlert = `CRITICAL: Transformer temp is ${tempTransformer.toFixed(1)}°C.`;
			else if (tempTransformer > TEMP_WARNING_THRESHOLD)
				processedData.flags.highTemperatureAlert = `WARNING: Transformer temp is ${tempTransformer.toFixed(1)}°C.`;
			const lastTemp = nodeMemoryStore[nodeId].lastTemperature;
			if (
				lastTemp !== null &&
				Math.abs(tempTransformer - lastTemp) > TEMP_SUDDEN_CHANGE_THRESHOLD
			)
				processedData.flags.suddenTemperatureChange = `Rapid temp change from ${lastTemp.toFixed(1)}°C to ${tempTransformer.toFixed(1)}°C.`;
			nodeMemoryStore[nodeId].lastTemperature = tempTransformer;
		}
		if (dataType === "electrical") {
			const { ac } = payload.data;
			const { circuits, voltage } = ac;
			processedData.calculatedMetrics.voltageUnbalancePercent =
				calculateVoltageUnbalance(voltage);
			processedData.calculatedMetrics.currentUnbalancePercent =
				calculateCurrentUnbalance(circuits);
			if (
				processedData.calculatedMetrics.voltageUnbalancePercent >
				VOLTAGE_UNBALANCE_THRESHOLD
			)
				processedData.flags.highVoltageUnbalance = `Voltage unbalance is high at ${processedData.calculatedMetrics.voltageUnbalancePercent.toFixed(2)}%.`;
			if (
				processedData.calculatedMetrics.currentUnbalancePercent >
				CURRENT_UNBALANCE_THRESHOLD
			)
				processedData.flags.highCurrentUnbalance = `Current unbalance is high at ${processedData.calculatedMetrics.currentUnbalancePercent.toFixed(2)}%.`;
			const neutralCurrentRms = circuits["4"]?.current?.rms;
			const avgPhaseCurrent =
				[
					circuits["1"]?.current?.rms,
					circuits["2"]?.current?.rms,
					circuits["3"]?.current?.rms,
				].reduce((s, c) => s + (c || 0), 0) / 3;
			if (
				neutralCurrentRms &&
				avgPhaseCurrent > NEUTRAL_CURRENT_MIN_PHASE_AMPS &&
				neutralCurrentRms >
					avgPhaseCurrent * NEUTRAL_CURRENT_FACTOR_THRESHOLD
			)
				processedData.flags.highNeutralCurrent = `Neutral current (${neutralCurrentRms.toFixed(2)}A) is >${NEUTRAL_CURRENT_FACTOR_THRESHOLD * 100}% of avg phase current (${avgPhaseCurrent.toFixed(2)}A).`;

			const lowPowerFactorIssues: string[] = [];
			const abnormalCrestFactorIssues: string[] = [];
			Object.entries(circuits)
				.slice(0, 3)
				.forEach(([id, c]: [string, any]) => {
					if (c.power?.power_factor?.total < POWER_FACTOR_THRESHOLD) {
						lowPowerFactorIssues.push(
							`L${id}: ${c.power.power_factor.total.toFixed(2)}`,
						);
					}
					if (c.current?.crest_factor > CREST_FACTOR_THRESHOLD) {
						abnormalCrestFactorIssues.push(
							`L${id}: ${c.current.crest_factor.toFixed(2)}`,
						);
					}
				});
			if (lowPowerFactorIssues.length > 0) {
				processedData.flags.lowPowerFactor = `Low power factor detected on phase(s) ${lowPowerFactorIssues.join(", ")}.`;
			}
			if (abnormalCrestFactorIssues.length > 0) {
				processedData.flags.abnormalCrestFactor = `Abnormal crest factor detected on phase(s) ${abnormalCrestFactorIssues.join(", ")}.`;
			}

			if (!dataBuffer[nodeId]) dataBuffer[nodeId] = {};
			for (let i = 1; i <= 3; i++) {
				const metricName = `circuit_${i}_current_rms`;
				const value = circuits[i.toString()]?.current?.rms;
				if (value !== undefined) {
					if (!dataBuffer[nodeId][metricName])
						dataBuffer[nodeId][metricName] = [];
					dataBuffer[nodeId][metricName].push({
						value,
						timestamp: payload.timestamp,
					});
				}
			}
		}

		latestNodePayload[nodeId] = processedData;

		if (Object.keys(processedData.flags).length > 0) {
			console.log(
				`[${new Date().toISOString()}] Flag detected for node ${nodeId}. Posting to API immediately.`,
			);
			await postToApi(endpoint0Url!, endpoint0Token!, processedData);
			await postToApi(endpoint1Url!, endpoint1Token!, processedData);
			lastApiPostTime[nodeId] = Date.now();
		}
	} catch (error) {
		console.error("Error processing message:", error);
	}
});

client.on("error", (err) => console.error("MQTT Client Error:", err));
