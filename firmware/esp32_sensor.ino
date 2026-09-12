#include "DHT.h"
#include <ArduinoJson.h>
#include <Wire.h>

// --- Pin Definitions ---
const int mq3Pin   = 32;
const int mq135Pin = 33;
const int mq9Pin   = 34;
const int mq5Pin   = 35;

const int trigPin = 5;
const int echoPin = 18;

#define DHTPIN 4
#define DHTTYPE DHT22
DHT dht(DHTPIN, DHTTYPE);

// --- MPU6050 Setup (Raw I2C) ---
const int MPU = 0x68; 
int16_t AcX, AcY, AcZ;

void setup() {
  Serial.begin(115200);
  
  pinMode(trigPin, OUTPUT);
  pinMode(echoPin, INPUT);
  
  dht.begin();
  
  // Initialize MPU6050
  Wire.begin(); 
  Wire.beginTransmission(MPU);
  Wire.write(0x6B);  // PWR_MGMT_1 register
  Wire.write(0);     // Wake up the MPU6050
  Wire.endTransmission(true);
}

void loop() {
  // ArduinoJson v7 syntax
  JsonDocument doc;

  // 1. Read Gas Sensors
  doc["mq3"] = analogRead(mq3Pin);
  doc["mq135"] = analogRead(mq135Pin);
  doc["mq9"] = analogRead(mq9Pin);
  doc["mq5"] = analogRead(mq5Pin);

  // 2. Current Sensor Placeholder
  doc["current"] = 0; 

  // 3. Read DHT22
  float temp = dht.readTemperature();
  doc["temperature"] = isnan(temp) ? 0 : temp;

  // 4. Read HC-SR04
  digitalWrite(trigPin, LOW); delayMicroseconds(2);
  digitalWrite(trigPin, HIGH); delayMicroseconds(10);
  digitalWrite(trigPin, LOW);
  float distance = pulseIn(echoPin, HIGH) * 0.034 / 2;
  doc["hcsr04"] = distance;

  // 5. Read MPU6050 (Acceleration & Tilt)
  Wire.beginTransmission(MPU);
  Wire.write(0x3B);  
  Wire.endTransmission(false);
  Wire.requestFrom(MPU, 6, true);  
  
  AcX = Wire.read() << 8 | Wire.read();  
  AcY = Wire.read() << 8 | Wire.read();  
  AcZ = Wire.read() << 8 | Wire.read();  

  // Convert raw values
  float accel_mag = sqrt(pow(AcX, 2) + pow(AcY, 2) + pow(AcZ, 2)) / 16384.0;
  float angle_x = atan2(AcY, AcZ) * 180.0 / PI;
  float angle_y = atan2(-AcX, sqrt(pow(AcY, 2) + pow(AcZ, 2))) * 180.0 / PI;
  float max_tilt = max(abs(angle_x), abs(angle_y));
  
  doc["acceleration"] = accel_mag;
  doc["rotation"] = max_tilt; 

  // 6. Send JSON via Serial
  serializeJson(doc, Serial);
  Serial.println();
  
  delay(1000); // 1-second interval
}
