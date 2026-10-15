/*
  Farm-to-Fork Sensor Node — ESP32 firmware

  Reads temperature/humidity (DHT22) and an ethylene proxy gas sensor (analog,
  e.g. MQ-135), then POSTs a JSON reading to the backend server. If WiFi or
  the server is unreachable, readings are stored on SD and published over MQTT
  after reconnect. The SD queue entry is removed only after backend acknowledgment.

  Wiring (adjust pins to your board):
    DHT22 data pin        -> GPIO 4
    Ethylene sensor (AOUT)-> GPIO 34 (ADC1_CH6)

  Required Arduino libraries (Library Manager):
    - DHT sensor library (Adafruit)
    - ArduinoJson
    - PubSubClient
    - SD (ships with the ESP32 Arduino core)

  Fill in the constants below before flashing.
*/

#include <WiFi.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <DHT.h>
#include <SPI.h>
#include <SD.h>

// ---------- Fill these in ----------
const char* WIFI_SSID     = "YOUR_WIFI_SSID";
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";
const char* MQTT_HOST     = "192.168.1.100"; // computer running the Farm-to-Fork server
const uint16_t MQTT_PORT  = 1883;
const char* DEVICE_API_KEY = "change-this-to-a-long-random-secret";   // must match backend .env
const char* DEVICE_ID     = "esp32-node-01";
const char* PRODUCT_ID    = ""; // set to the registered product ID to associate readings
const char* BATCH_ID      = ""; // must match the registered product batch
// ------------------------------------

#define DHTPIN 4
#define DHTTYPE DHT22
#define ETHYLENE_PIN 34
#define SD_CS_PIN 5 // change to the chip-select pin wired to your SD module

DHT dht(DHTPIN, DHTTYPE);
WiFiClient mqttNetwork;
PubSubClient mqttClient(mqttNetwork);

const char* QUEUE_FILE = "/queue.jsonl";
const char* QUEUE_TEMP_FILE = "/queue.tmp";
const char* QUEUE_BACKUP_FILE = "/queue.bak";
String readingTopic;
String ackTopic;
String waitingForEventId;
const unsigned long SAMPLE_INTERVAL_MS = 10000; // read + send every 10s
const unsigned long MQTT_RETRY_INTERVAL_MS = 3000;
const unsigned long MQTT_ACK_TIMEOUT_MS = 10000;
unsigned long lastSample = 0;
unsigned long lastMqttAttempt = 0;
unsigned long lastPublishAttempt = 0;

void setup() {
  Serial.begin(115200);
  dht.begin();

  if (!SD.begin(SD_CS_PIN)) {
    Serial.println("SD card mount failed; sensor readings cannot be queued");
  } else {
    recoverQueueFiles();
    Serial.println("SD card ready; readings will be queued before MQTT delivery");
  }

  mqttClient.setServer(MQTT_HOST, MQTT_PORT);
  mqttClient.setCallback(onMqttMessage);
  mqttClient.setBufferSize(1024);
  readingTopic = String("farm2fork/readings/") + DEVICE_ID;
  ackTopic = String("farm2fork/acks/") + DEVICE_ID;
  connectWiFi();
}

void loop() {
  maintainWiFi();
  maintainMqtt();
  if (mqttClient.connected()) mqttClient.loop();

  if (millis() - lastSample >= SAMPLE_INTERVAL_MS) {
    lastSample = millis();
    takeReadingAndSend();
  }

  publishNextQueuedReading();
}

void connectWiFi() {
  Serial.printf("Connecting to WiFi %s", WIFI_SSID);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 15000) {
    delay(500);
    Serial.print(".");
  }
  Serial.println(WiFi.status() == WL_CONNECTED ? "\nWiFi connected" : "\nWiFi connect timed out (will retry)");
}

void maintainWiFi() {
  if (WiFi.status() != WL_CONNECTED && millis() - lastMqttAttempt >= MQTT_RETRY_INTERVAL_MS) {
    lastMqttAttempt = millis();
    connectWiFi();
  }
}

void maintainMqtt() {
  if (WiFi.status() != WL_CONNECTED || mqttClient.connected()) return;
  if (millis() - lastMqttAttempt < MQTT_RETRY_INTERVAL_MS) return;
  lastMqttAttempt = millis();

  String clientId = String(DEVICE_ID) + "-" + String((uint32_t)esp_random(), HEX);
  if (mqttClient.connect(clientId.c_str())) {
    mqttClient.subscribe(ackTopic.c_str());
    Serial.println("MQTT connected; waiting for backend delivery acknowledgments");
  } else {
    Serial.printf("MQTT connection failed (%d); queued readings are retained on SD\n", mqttClient.state());
  }
}

// Reads sensors and builds a JSON reading. Replace the ethylene conversion
// with your sensor's actual calibration curve.
String buildReadingJson() {
  float temp = dht.readTemperature();
  float hum  = dht.readHumidity();
  int raw    = analogRead(ETHYLENE_PIN);        // 0-4095 on ESP32 ADC
  float eth  = (raw / 4095.0) * 5.0;             // placeholder linear mapping to ppm

  if (isnan(temp) || isnan(hum)) {
    Serial.println("DHT read failed, skipping this cycle");
    return "";
  }

  StaticJsonDocument<512> doc;
  String eventId = String(DEVICE_ID) + "-" + String((uint32_t)millis(), HEX) + "-" + String((uint32_t)esp_random(), HEX);
  doc["device_id"] = DEVICE_ID;
  doc["event_id"]  = eventId;
  if (strlen(PRODUCT_ID) > 0) doc["product_id"] = PRODUCT_ID;
  if (strlen(BATCH_ID) > 0) doc["batch_id"] = BATCH_ID;
  doc["temp"]      = temp;
  doc["hum"]       = hum;
  doc["eth"]       = eth;

  String out;
  serializeJson(doc, out);
  return out;
}

bool queueReading(const String& json) {
  if (!SD.cardType()) {
    Serial.println("Cannot queue reading because SD is unavailable");
    return false;
  }
  File file = SD.open(QUEUE_FILE, FILE_APPEND);
  if (!file) { Serial.println("Failed to open SD queue file"); return false; }
  file.println(json);
  file.close();
  Serial.println("Reading persisted to SD queue");
  return true;
}

void takeReadingAndSend() {
  String json = buildReadingJson();
  if (json.length() > 0) queueReading(json);
}

void publishNextQueuedReading() {
  if (WiFi.status() != WL_CONNECTED || !mqttClient.connected() || !SD.exists(QUEUE_FILE)) return;
  if (millis() - lastPublishAttempt < MQTT_RETRY_INTERVAL_MS) return;
  if (waitingForEventId.length() > 0 && millis() - lastPublishAttempt < MQTT_ACK_TIMEOUT_MS) return;

  File queue = SD.open(QUEUE_FILE, FILE_READ);
  if (!queue || !queue.available()) { if (queue) queue.close(); return; }
  String json = queue.readStringUntil('\n');
  queue.close();
  json.trim();
  if (json.length() == 0) return;

  StaticJsonDocument<512> doc;
  if (deserializeJson(doc, json)) {
    Serial.println("Invalid JSON at head of SD queue; retaining it for inspection");
    return;
  }
  const char* eventId = doc["event_id"] | "";
  if (strlen(eventId) == 0) return;
  doc["api_key"] = DEVICE_API_KEY;
  String publishPayload;
  serializeJson(doc, publishPayload);

  waitingForEventId = eventId;
  lastPublishAttempt = millis();
  if (!mqttClient.publish(readingTopic.c_str(), publishPayload.c_str())) {
    waitingForEventId = "";
    Serial.println("MQTT publish failed; reading remains on SD");
  } else {
    Serial.printf("Published queued event %s; waiting for backend acknowledgment\n", eventId);
  }
}

void onMqttMessage(char* topic, byte* payload, unsigned int length) {
  if (ackTopic != topic) return;
  StaticJsonDocument<256> ack;
  if (deserializeJson(ack, payload, length)) return;
  const char* eventId = ack["event_id"] | "";
  if (waitingForEventId != eventId) return;

  if (ack["ok"] | false) {
    if (removeQueuedEvent(eventId)) {
      Serial.printf("Backend acknowledged event %s; removed it from SD queue\n", eventId);
      waitingForEventId = "";
    }
  } else {
    Serial.printf("Backend rejected event %s: %s; retaining it on SD\n", eventId, ack["error"] | "unknown error");
    waitingForEventId = "";
    lastPublishAttempt = millis();
  }
}

bool removeQueuedEvent(const char* eventId) {
  File input = SD.open(QUEUE_FILE, FILE_READ);
  if (!input) return false;
  SD.remove(QUEUE_TEMP_FILE);
  File output = SD.open(QUEUE_TEMP_FILE, FILE_WRITE);
  if (!output) { input.close(); return false; }

  bool removed = false;
  while (input.available()) {
    String line = input.readStringUntil('\n');
    line.trim();
    if (line.length() == 0) continue;
    StaticJsonDocument<512> queued;
    bool matches = !removed && !deserializeJson(queued, line) &&
      String(queued["event_id"] | "") == eventId;
    if (matches) removed = true;
    else output.println(line);
  }
  input.close();
  output.close();
  if (!removed) { SD.remove(QUEUE_TEMP_FILE); return false; }
  SD.remove(QUEUE_BACKUP_FILE);
  if (!SD.rename(QUEUE_FILE, QUEUE_BACKUP_FILE)) { SD.remove(QUEUE_TEMP_FILE); return false; }
  if (!SD.rename(QUEUE_TEMP_FILE, QUEUE_FILE)) {
    SD.rename(QUEUE_BACKUP_FILE, QUEUE_FILE);
    return false;
  }
  SD.remove(QUEUE_BACKUP_FILE);
  return true;
}

void recoverQueueFiles() {
  if (!SD.exists(QUEUE_FILE) && SD.exists(QUEUE_BACKUP_FILE)) {
    SD.rename(QUEUE_BACKUP_FILE, QUEUE_FILE);
  } else if (SD.exists(QUEUE_FILE) && SD.exists(QUEUE_BACKUP_FILE)) {
    SD.remove(QUEUE_BACKUP_FILE);
  }
  if (SD.exists(QUEUE_TEMP_FILE)) SD.remove(QUEUE_TEMP_FILE);
}
