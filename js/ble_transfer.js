/**
 * BLE Image Transfer Module with CRC16 Checksum and Resume Support
 * 
 * 功能特点:
 * 1. CRC16-CCITT 数据完整性校验
 * 2. 批量确认模式 - 发送N个块后验证
 * 3. 断点续传 - 断开重连后从上次位置继续
 * 4. 支持三色屏多层传输
 * 5. 传输速度显示
 * 6. 断连检测和恢复
 * 7. 可配置日志级别
 */

const BleTransfer = {
    // 配置常量
    MAX_RETRIES: 3,          // 最大重试轮次
    BATCH_SIZE: 20,          // 每批发送的块数（针对手机端稳定性优化）
    BATCH_DELAY_MS: 150,     // 批处理后延迟，等待MCU处理

    // 日志级别: 0=无, 1=错误, 2=信息, 3=调试
    logLevel: 2,

    // 状态变量
    sessionId: 0,
    currentLayer: 0x0F,      // 当前图层: 0x0F=黑白层, 0x00=彩色层
    pendingStatus: null,
    statusResolver: null,
    statusRequestId: 0,
    block0Sent: false,       // 跟踪是否已发送当前图层的块0

    // 传输速度统计
    transferStats: {
        startTime: 0,
        bytesSent: 0,
        blocksSent: 0
    },

    /**
     * 日志辅助函数，带级别控制
     * @param {number} level - 日志级别 (1=错误, 2=信息, 3=调试)
     * @param {string} message - 日志消息
     * @param {any} data - 可选数据
     */
    log(level, message, data = null) {
        if (level > this.logLevel) return;

        const prefix = '[BleTransfer]';
        if (level === 1) {
            if (data) console.error(prefix, message, data);
            else console.error(prefix, message);
        } else if (level === 2) {
            if (data) console.log(prefix, message, data);
            else console.log(prefix, message);
        } else {
            if (data) console.debug(prefix, message, data);
            else console.debug(prefix, message);
        }
    },

    /**
     * 检查BLE是否仍然连接
     * @returns {boolean} 连接状态
     */
    isConnected() {
        return typeof epdCharacteristic !== 'undefined' &&
            epdCharacteristic !== null &&
            typeof bleDevice !== 'undefined' &&
            bleDevice !== null &&
            bleDevice.gatt &&
            bleDevice.gatt.connected;
    },

    /**
     * CRC16-CCITT 计算
     * @param {Uint8Array} data - 要校验的数据
     * @returns {number} 16位CRC值
     */
    crc16(data) {
        let crc = 0xFFFF;
        for (let i = 0; i < data.length; i++) {
            crc ^= data[i];
            for (let j = 0; j < 8; j++) {
                crc = (crc & 1) ? (crc >>> 1) ^ 0x8408 : crc >>> 1;
            }
        }
        return crc & 0xFFFF;
    },

    /**
     * 计算传输速度
     * @returns {Object} 速度信息 { bytesPerSecond, kbps, elapsed }
     */
    getTransferSpeed() {
        const elapsed = (Date.now() - this.transferStats.startTime) / 1000;
        if (elapsed <= 0) return { bytesPerSecond: 0, kbps: 0, elapsed: 0 };

        const bytesPerSecond = this.transferStats.bytesSent / elapsed;
        return {
            bytesPerSecond: bytesPerSecond,
            kbps: (bytesPerSecond * 8 / 1000).toFixed(1),
            elapsed: elapsed.toFixed(1)
        };
    },

    /**
     * 格式化速度显示
     * @returns {string} 格式化的速度字符串
     */
    getSpeedString() {
        const speed = this.getTransferSpeed();
        if (speed.bytesPerSecond < 1024) {
            return `${speed.bytesPerSecond.toFixed(0)} B/s`;
        } else {
            return `${(speed.bytesPerSecond / 1024).toFixed(1)} KB/s`;
        }
    },

    /**
     * 处理MCU通知（从main.js的handleNotify调用）
     * @param {DataView|Uint8Array} value - 通知数据
     */
    handleNotification(value) {
        let data;
        if (value instanceof DataView) {
            data = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
        } else if (value instanceof Uint8Array) {
            data = value;
        } else {
            data = new Uint8Array(value);
        }

        if (data[0] === 0xA0) {
            // 块ACK/NACK: [0xA0, block_id_L, block_id_H, status]
            const blockId = data[1] | (data[2] << 8);
            const status = data[3];
            this.log(3, `Block ${blockId} ACK: ${status === 0 ? 'OK' : 'FAIL'}`);
        } else if (data[0] === 0xA1) {
            // 状态响应: [0xA1, total_L, total_H, received_L, received_H, session, active, bitmap...]
            this.pendingStatus = {
                total: data[1] | (data[2] << 8),
                received: data[3] | (data[4] << 8),
                sessionId: data[5],
                active: data[6] === 1,
                bitmap: data.slice(7)
            };
            this.log(3, 'Status:', this.pendingStatus);

            if (this.statusResolver) {
                const resolver = this.statusResolver;
                this.statusResolver = null;
                resolver(this.pendingStatus);
            }
        }
    },

    /**
     * 查询MCU传输状态（带超时）
     * @param {number} timeout - 超时毫秒数
     * @returns {Promise<Object|null>} 传输状态或null
     */
    async queryStatus(timeout = 2000) {
        // 先检查连接
        if (!this.isConnected()) {
            this.log(1, 'Cannot query status: BLE disconnected');
            throw new Error('BLE disconnected');
        }

        this.pendingStatus = null;
        this.statusRequestId++;
        const requestId = this.statusRequestId;

        return new Promise(async (resolve) => {
            const timer = setTimeout(() => {
                if (this.statusRequestId === requestId) {
                    this.statusResolver = null;
                    resolve(this.pendingStatus);
                }
            }, timeout);

            this.statusResolver = (status) => {
                clearTimeout(timer);
                resolve(status);
            };

            try {
                await write(EpdCmd.QUERY_STATUS);
            } catch (e) {
                clearTimeout(timer);
                this.statusResolver = null;
                this.log(1, 'Query status failed:', e);
                resolve(null);
            }
        });
    },

    /**
     * 重置MCU传输状态
     * @param {number} newSessionId - 可选的新会话ID
     */
    async resetTransfer(newSessionId) {
        // 先检查连接
        if (!this.isConnected()) {
            this.log(1, 'Cannot reset transfer: BLE disconnected');
            throw new Error('BLE disconnected');
        }

        this.sessionId = newSessionId !== undefined ? newSessionId : (Date.now() & 0xFF);
        this.block0Sent = false;

        // 重置统计
        this.transferStats = {
            startTime: Date.now(),
            bytesSent: 0,
            blocksSent: 0
        };

        await write(EpdCmd.RESET_TRANSFER, [this.sessionId]);
        await new Promise(r => setTimeout(r, 100));
        this.log(2, 'Transfer reset, session:', this.sessionId);
    },

    /**
     * 发送单个块（快速模式，不等待ACK）
     * @param {number} blockId - 块ID
     * @param {number} totalBlocks - 总块数
     * @param {Uint8Array} payload - 数据负载
     * @param {boolean} withResponse - 是否等待BLE写入响应
     */
    async sendBlockFast(blockId, totalBlocks, payload, withResponse = false) {
        // 发送前检查连接
        if (!this.isConnected()) {
            this.log(1, 'Cannot send block: BLE disconnected');
            throw new Error('BLE disconnected');
        }

        const crc = this.crc16(payload);

        // 计算cfg字节: 低4位=图层, 高4位=首块标志
        // 块0需要0x00（发送RAM命令），其他块使用0xF0（继续）
        let cfg;
        if (blockId === 0) {
            // 块0总是使用首块标志（发送RAM命令）
            cfg = 0x00 | (this.currentLayer & 0x0F);
            this.block0Sent = true;
        } else {
            // 其他块使用继续标志
            cfg = 0xF0 | (this.currentLayer & 0x0F);
        }

        // 数据包: [cmd][block_id:2][total:2][cfg:1][payload][crc:2]
        const packet = new Uint8Array(8 + payload.length);
        packet[0] = EpdCmd.WRITE_BLOCK;
        packet[1] = blockId & 0xFF;
        packet[2] = blockId >> 8;
        packet[3] = totalBlocks & 0xFF;
        packet[4] = totalBlocks >> 8;
        packet[5] = cfg;
        packet.set(payload, 6);
        packet[6 + payload.length] = crc & 0xFF;
        packet[7 + payload.length] = crc >> 8;

        try {
            if (withResponse) {
                await epdCharacteristic.writeValueWithResponse(packet);
            } else {
                await epdCharacteristic.writeValueWithoutResponse(packet);
            }

            // 更新统计
            this.transferStats.bytesSent += payload.length;
            this.transferStats.blocksSent++;
        } catch (e) {
            this.log(1, `Failed to send block ${blockId}:`, e);
            throw e;
        }
    },

    /**
     * 从状态获取缺失的块列表
     * @param {Object} status - 传输状态对象
     * @param {number} totalBlocks - 总块数
     * @returns {Array<number>} 缺失的块ID数组
     */
    getMissingBlocks(status, totalBlocks) {
        const missing = [];
        if (!status || !status.bitmap || status.bitmap.length === 0) {
            for (let i = 0; i < totalBlocks; i++) missing.push(i);
            return missing;
        }

        for (let i = 0; i < totalBlocks; i++) {
            const byteIdx = Math.floor(i / 8);
            const bitIdx = i % 8;
            if (byteIdx >= status.bitmap.length ||
                !(status.bitmap[byteIdx] & (1 << bitIdx))) {
                missing.push(i);
            }
        }
        return missing;
    },

    /**
     * 带CRC校验和断点续传的图像发送
     * @param {Uint8Array} data - 要发送的图像数据
     * @param {string} step - 'bw' 黑白层, 'red' 彩色层
     * @param {function} onProgress - 进度回调 (blocksSent, totalBlocks, speedInfo)
     * @returns {Promise<boolean>} 成功返回true
     */
    async sendImageWithResume(data, step = 'bw', onProgress = null) {
        // 开始前检查连接
        if (!this.isConnected()) {
            this.log(1, 'Cannot start transfer: BLE disconnected');
            throw new Error('BLE disconnected');
        }

        let mtu = parseInt(document.getElementById('mtusize').value);
        if (isNaN(mtu) || mtu < 20) {
            this.log(2, 'Invalid MTU value, using default 20');
            mtu = 20;
        }
        // 考虑头部和CRC开销
        const chunkSize = Math.max(mtu - 8, 20);
        const totalBlocks = Math.ceil(data.length / chunkSize);

        // 根据步骤设置当前图层
        this.currentLayer = (step === 'bw') ? 0x0F : 0x00;

        // 重置传输状态（同时重置统计）
        await this.resetTransfer(Date.now() & 0xFF);

        this.log(2, `Starting transfer: ${totalBlocks} blocks, ${data.length} bytes, layer=${step}`);

        for (let retryRound = 0; retryRound < this.MAX_RETRIES; retryRound++) {
            let missingBlocks;

            // 优化：第一轮跳过状态查询（复位后位图为空）
            if (retryRound === 0) {
                // 第一轮：发送所有块
                missingBlocks = Array.from({ length: totalBlocks }, (_, i) => i);
            } else {
                // 重试轮次：查询状态找出缺失块
                let status;
                try {
                    status = await this.queryStatus();
                } catch (e) {
                    this.log(1, 'Status query failed:', e);
                    if (!this.isConnected()) {
                        throw new Error('BLE disconnected during transfer');
                    }
                    status = { total: 0, received: 0, bitmap: new Uint8Array(0) };
                }

                missingBlocks = this.getMissingBlocks(status, totalBlocks);

                if (missingBlocks.length === 0) {
                    // 传输完成
                    const speed = this.getTransferSpeed();
                    this.log(2, `Transfer complete: ${totalBlocks} blocks, ${speed.elapsed}s, ${this.getSpeedString()}`);
                    return true;
                }
            }

            this.log(2, `Round ${retryRound + 1}: ${missingBlocks.length} blocks to send`);

            // 分批发送缺失块
            for (let i = 0; i < missingBlocks.length; i++) {
                // 定期检查连接状态
                if (i % 10 === 0 && !this.isConnected()) {
                    this.log(1, 'BLE disconnected during transfer');
                    throw new Error('BLE disconnected during transfer');
                }

                const blockId = missingBlocks[i];
                const offset = blockId * chunkSize;
                const payload = data.slice(offset, Math.min(offset + chunkSize, data.length));

                // 跳过空负载（可能出现在数据边界正好对齐时）
                if (payload.length === 0) {
                    continue;
                }

                // 批处理最后一块或整体最后一块使用响应模式
                const isLastInBatch = ((i + 1) % this.BATCH_SIZE === 0);
                const isLastBlock = (i === missingBlocks.length - 1);
                const useResponse = isLastInBatch || isLastBlock;

                await this.sendBlockFast(blockId, totalBlocks, payload, useResponse);

                if (onProgress) {
                    const speedInfo = this.getTransferSpeed();
                    onProgress(i + 1, missingBlocks.length, speedInfo);
                }
            }

            // 等待MCU处理，然后检查状态
            await new Promise(r => setTimeout(r, this.BATCH_DELAY_MS));

            // 第一轮结束后检查是否所有块都收到了
            if (retryRound === 0) {
                let status;
                try {
                    status = await this.queryStatus();
                    const stillMissing = this.getMissingBlocks(status, totalBlocks);
                    if (stillMissing.length === 0) {
                        const speed = this.getTransferSpeed();
                        this.log(2, `Transfer complete: ${totalBlocks} blocks, ${speed.elapsed}s, ${this.getSpeedString()}`);
                        return true;
                    } else {
                        this.log(2, `${stillMissing.length} blocks missing, will retry`);
                    }
                } catch (e) {
                    this.log(1, 'Post-transfer status query failed:', e);
                }
            }
        }

        const speed = this.getTransferSpeed();
        this.log(1, `Transfer failed after ${this.MAX_RETRIES} retries, ${speed.elapsed}s`);
        throw new Error('Transfer failed after max retries');
    },

    /**
     * 设置日志级别
     * @param {number} level - 0=无, 1=错误, 2=信息, 3=调试
     */
    setLogLevel(level) {
        this.logLevel = Math.max(0, Math.min(3, level));
        this.log(2, `Log level set to ${this.logLevel}`);
    },

    /**
     * 初始化传输模块（连接时调用）
     */
    init() {
        this.pendingStatus = null;
        this.statusResolver = null;
        this.statusRequestId = 0;
        this.block0Sent = false;
        this.transferStats = {
            startTime: 0,
            bytesSent: 0,
            blocksSent: 0
        };
        this.log(2, 'Transfer module initialized');
    }
};

// 导出供main.js使用
if (typeof window !== 'undefined') {
    window.BleTransfer = BleTransfer;
}