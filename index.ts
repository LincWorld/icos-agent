import mqtt from 'mqtt';
import TTLCache from '@isaacs/ttlcache';
import { mean, min, max, median, sum, std, variance } from 'mathjs';
import axios from 'axios';

// Parameters for MQTT Broker
const mqtt_protocol = process.env.MQTT_PROTOCOL || "mqtt";
const mqtt_broker = process.env.MQTT_BROKER || "localhost";
const mqtt_port = +(process.env.MQTT_PORT || "1883");

const publish_url = process.env.PUBLISH_URL || "http://localhost:8080";

const agg_period = +(process.env.AGG_PERIOD || "300");
const agg_period_ms = agg_period * 1000;

const cache = new TTLCache<string, { id: string, timestamp: number, data: { [key: string]: number } }>({ ttl: agg_period_ms * 3 })

const publish = (obj) => {
	axios.post(publish_url, obj)
		.then(function (response) {
			console.log(response);
		})
		.catch(function (error) {
			console.log(error);
		});
}

const aggregator = () => {
	let current = Math.floor(new Date().getTime() / 1000 / agg_period) * agg_period;
	const items = Array.from(cache.entries()).filter((e) => {
		return e[1].timestamp <= current || (e[1].timestamp > current - agg_period)
	}).reduce((arr, [_k, e], i) => {
		arr[e.id] = arr[e.id] || {};
		Object.keys(e.data).forEach((k) => {
			arr[e.id][k] = arr[e.id][k] || [];
			arr[e.id][k].push(e.data[k]);
		})
		return arr;
	}, {});
	let res = {};
	Object.keys(items).forEach((id) => {
		Object.keys(items[id]).forEach((key) => {
			res[id] = {
				timestamp: current / 1000,
				mean: mean(items[id][key]),
				min: min(items[id][key]),
				max: max(items[id][key]),
				median: median(items[id][key]),
				sum: sum(items[id][key]),
				std: std(items[id][key]),
				variance: variance(items[id][key])
			}
		})
	});
	publish(res);
}

const main = async () => {
	const client = mqtt.connect(`${mqtt_protocol}://${mqtt_broker}:${mqtt_port}`);

	client.on("connect", () => {
		console.log("Connected")
		client.subscribe("measurements", (err) => {
			if (!err) {

			}
		});
	});

	client.on("message", (topic, message) => {
		// message is Buffer
		const msg = JSON.parse(message.toString());
		cache.set(`${msg.id}-${msg.timestamp}`, msg);
	});

	setInterval(aggregator, agg_period_ms)
}

main();
