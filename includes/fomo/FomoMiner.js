// 导入 suidouble 库
import suidouble from 'suidouble';
// 从 @mysten/sui/bcs 导入 bcs 对象
import { bcs } from '@mysten/sui/bcs';
// 导入 js-sha3 哈希库
import hasher from 'js-sha3';
// 导入自定义的数学工具函数
import { bytesTou64, bigIntTo32Bytes, u64toBytes } from '../math.js';
// 导入 NonceFinder 类
import NonceFinder from '../NonceFinder.js';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

// 定义 FomoMiner 类
export default class FomoMiner {
    // 构造函数,接受一个可选的参数对象
    constructor(params = {}) {
        // 初始化 _suiMaster,如果没有提供则为 null
        this._suiMaster = params.suiMaster || null;
        
        // 初始化 _buses,如果没有提供则为 null
        this._buses = params.buses || null;
        // 初始化 _configId,如果没有提供则为 null
        this._configId = params.configId || null;
        // 初始化 _packageId,如果没有提供则为 null
        this._packageId = params.packageId || null;

        // 创建一个新的 NonceFinder 实例,名称为 'FOMO'
        this._nonceFinder = new NonceFinder({ name: 'FOMO' });

        // 初始化 _config 为 null
        this._config = null;
        // 初始化 _movePackage 为 null
        this._movePackage = null;

        this.lockFilePath = path.join(os.homedir(), '.mine_lock');
        this.lockTimeout = 60000; // 锁的超时时间，单位毫秒
    }

    async checkObjects() {
        // 如果已经有正在进行的检查,直接返回该Promise
        if (this.__checkObjectsPromise) {
            return await this.__checkObjectsPromise;
        }

        // 初始化Promise解析器
        this.__checkObjectsPromiseResolver = null;
        // 创建新的Promise
        this.__checkObjectsPromise = new Promise((res)=>{ this.__checkObjectsPromiseResolver = res; });

        // 检必要的参数是否存在
        if (!this._configId || !this._packageId || !this._buses) {
            throw new Error('FOMO | configId, packageId are required');
        }

        // 获取SuiObject类
        const SuiObject = suidouble.SuiObject;
        
        // 创建配置对象
        const config = new SuiObject({
            id: this._configId,
            suiMaster: this._suiMaster,
        });
        // 将配置对象添加到对象存储中
        this._suiMaster.objectStorage.push(config);

        // 从区块链获取配置对象的字段
        await config.fetchFields();

        // 保存配置对象
        this._config = config;

        // 创建并添加Move包
        const movePackage = this._suiMaster.addPackage({
            id: this._packageId,
        });
        // 检查包是否在区块链上
        await movePackage.isOnChain();

        // 保存Move包
        this._movePackage = movePackage;

        // 解析Promise,表示初始化完成
        this.__checkObjectsPromiseResolver(true);

        return true;
    }

    async getOrCreateMiner() {
        // 确保对象已经检查完毕
        await this.checkObjects();

        // 如果开启了调试模式,输出日志
        if (this._suiMaster._debug) {
            console.log('FOMO | Trying to find the miner object already registered on the blockchain....');
        }
        // 获取已拥有的Miner对象
        const paginated = await this._movePackage.modules.miner.getOwnedObjects({ typeName: 'Miner' });
        let miner = null;
        await paginated.forEach((suiObject)=>{ miner = suiObject; });

        // 如果找到了Miner对象
        if (miner) {
            if (this._suiMaster._debug) {
                console.log('FOMO | It is there, id is: ', miner.id);
            }
            return miner;
        }

        // 如果没有找到Miner对象,注册一个新的
        console.log('FOMO | Can not find it. Lets register the new one...');

        // 调用register方法注册新的Miner
        await this._movePackage.modules.miner.moveCall('register', []);

        console.log('FOMO | Miner succesfully registered');
        // 等待2秒
        await new Promise((res)=>{ setTimeout(res, 2000); });

        // 重新获取Miner对象
        return await this.getOrCreateMiner();
    }

    async fetchBus() {
        // 确保对象已经检查完毕
        await this.checkObjects();
        // 从总线数组中随机选择一个总线ID
        const randomBusId = this._buses[Math.floor(Math.random() * this._buses.length)];

        // 创建一个新的SuiObject实例，代表中的总线
        const bus = new (this._suiMaster.SuiObject)({ id: randomBusId, suiMaster: this._suiMaster });
        // 从区块链获取总线对象的字段
        await bus.fetchFields();

        return bus;
    }

    async hasBlockInfoChanged(oldHash) {
        // 获取或创建矿工对象
        const miner = await this.getOrCreateMiner();
        // 获取新的哈希值
        const newHash = new Uint8Array(miner.fields.current_hash); // 在新区块上发生变化

        // 比较旧哈希和新哈希
        if (bytesTou64(oldHash) != bytesTou64(newHash)) {
            return true;
        }
        return false;
    }

    async mine(startNonce = 0) {
        // 确保对象已经检查完毕
        await this.checkObjects();

        // 获取或创建矿工对象
        let miner = await this.getOrCreateMiner();
        // 获取总线对象
        let bus = await this.fetchBus();
        // 获取当前哈希值
        const currentHash = new Uint8Array(miner.fields.current_hash); // 在新区块上发生变化
        // 获取签名者地址的字节表示
        const signerAddressBytes = bcs.Address.serialize(this._suiMaster.address).toBytes();
        // 获取难度值
        const difficulty = Number(bus.fields.difficulty);
        // 将难度转换为目标值
        const difficultyAsTarget = '0x'+(''.padEnd(difficulty*2, '00').padEnd(64, 'ff'));

        let foundValid = false;
        // 准备哈希值
        let preparedHash = this.prepareHash(currentHash, signerAddressBytes);
        let nonce = startNonce || 0;
        // 记录开始寻找nonce的时间
        const startFindingNonceAt = (new Date()).getTime();

        let isOutdated = false;
        // 设置定期检查区块信息是否过期的定时器
        const __checkForOutdatedInterval = setInterval(()=>{
            try {
                this.hasBlockInfoChanged(currentHash)
                    .then((changed)=>{
                        console.log('FOMO | block hash changed', changed);
                        if (changed) {
                            isOutdated = true;
                            this._nonceFinder.pleaseStop();
                        }
                    })
                    .catch((e)=>{
                        console.error(e);
                    });
            } catch (e) {
                console.log(e);
            }
        }, 3000);

        // 主要挖矿循环
        while (!foundValid && !isOutdated) {

            // 寻找有效的nonce
            nonce = await this.withLock(async ()=>{
                // 重新获取矿工对象和准备哈希
                miner = await this.getOrCreateMiner();
                preparedHash = this.prepareHash(new Uint8Array(miner.fields.current_hash), signerAddressBytes);
                return await this._nonceFinder.findValidNonce(preparedHash, difficultyAsTarget);
            });

            if (nonce !== null) {
                console.log('FOMO | valid nonce '+nonce+' found in '+((new Date()).getTime() - startFindingNonceAt)+'ms');
                // 提交找到的nonce
                const success = await this.submit(nonce, bus, miner);
                if (success) {
                    foundValid = true;
                } else {
                    console.log('FOMO | blockInfo was wrong!!!');
                    nonce = nonce + 1;

                    miner = await this.getOrCreateMiner();
                    preparedHash = this.prepareHash(new Uint8Array(miner.fields.current_hash), signerAddressBytes);
                }
            } else {
                // 被要求停止 
                isOutdated = true;
            }
        };

        // 清除定时器
        clearInterval(__checkForOutdatedInterval);

        return true;
    }

    async prepare() {
        // 确保对象已经检查完毕
        await this.checkObjects();

        // 获取或创建矿工对象
        const miner = await this.getOrCreateMiner();
        // 获取当前哈希值
        const currentHash = new Uint8Array(miner.fields.current_hash); // 在新区块上发生变化
        // 初始化起始nonce为0
        let startNonce = BigInt(0);
        // 获取签名者地址的字节表示
        const signerAddressBytes = bcs.Address.serialize(this._suiMaster.address).toBytes();

        // 获取总线对象
        let bus = await this.fetchBus();
        // 输出调试信息
        console.log(signerAddressBytes);
        console.log(currentHash);
        console.log(miner.fields.current_hash);

        // 获取难度值
        const difficulty = Number(bus.fields.difficulty);
        console.log(difficulty);

        // 将难度转换为目标值
        const difficultyAsTarget = '0x'+(''.padEnd(difficulty*2, '00').padEnd(64, 'ff'));
        console.log(difficultyAsTarget);

        // 检查总线是否可用
        console.log(this.busIsOk(bus));

        // 准备哈希值
        const preparedHash = this.prepareHash(currentHash, signerAddressBytes);
        // 寻找有效的nonce
        let nonce = await this._nonceFinder.findValidNonce(preparedHash, difficultyAsTarget);
        console.log(nonce);

        // 如果找到有效nonce，提交结果
        if (nonce) {
            this.submit(nonce, bus, miner);
        }
    }

    busIsOk(bus) {
        // 定义一个周期长度（毫秒）
        const epochLength = 60000;
        // 检查总线是否有足够的奖励
        const fundsOk = BigInt(bus.fields.rewards) >= BigInt(bus.fields.reward_rate);
        // 计算重置阈值时间
        const threshold = Number(bus.fields.last_reset) + epochLength;

        // 设置缓冲时间（毫秒）
        const buffer = 4000;
        // 检查当前时间是否在有效范围内
        const resetTimeOk = Date.now() < threshold - buffer;

        // 返回总线是否可用（时间和资金都满足条件）
        return resetTimeOk && fundsOk;
    }

    async submit(nonce, bus, miner) {
        // 创建一个新的交易对象
        const tx = new suidouble.Transaction();

        // 准备交易参数
        const args = [
            tx.pure('u64', nonce),
            tx.object(bus.id), // 总线对象
            tx.object(miner.id), // 矿工对象
            tx.object('0x0000000000000000000000000000000000000000000000000000000000000006'), // 时钟对象
        ];

        // 创建一个Move调用
        const moveCallResult = tx.moveCall({
            target: `${this._packageId}::fomo::mine`,
            arguments: args
        });

        // 将调用结果转移到签名者地址
        tx.transferObjects([moveCallResult], this._suiMaster.address);

        try {
            // 签名并执行交易
            const r = await this._suiMaster.signAndExecuteTransaction({ 
                transaction: tx, 
                requestType: 'WaitForLocalExecution',
                sender: this._suiMaster.address, 
                options: {
                    "showEffects": true,
                    "showEvents": true,
                    "showObjectChanges": true,
                    showType: true,
                    showContent: true,
                    showOwner: true,
                    showDisplay: true,
                },
            });

            // 检查交易是否成功
            if (r && r.effects && r.effects.status && r.effects.status.status && r.effects.status.status == 'success') {
                console.log('FOMO | valid nonce submited');
                return true;
            } else {
                console.log('FOMO | can not submit nonce');
            }
        } catch (e) {
            console.log('FOMO | can not submit nonce');
            console.error(e);
        }

        return false;
    }

    async waitUntilNextReset(currentReset) {
        // 定义一个周期长度（毫秒）
        const epochLength = 60000;
        // 获取总线对象
        const bus = await this.fetchBus();
        // 计算下一次重置时间
        const nextReset = Number(bus.fields.last_reset) + epochLength;
        // 计算距离下次重置的时间
        const timeUntilNextReset = nextReset - Date.now();

        // 如果还没到下一次重置时间，等待
        if (timeUntilNextReset > 0) {
            await new Promise((res)=>setTimeout(res, timeUntilNextReset));
        }

        // 循环检查是否已经重置
        while (true) {
            const freshBus = await this.fetchBus();
            if (Number(freshBus.fields.last_reset) !== Number(currentReset)) {
                return true;
            } else {
                // 如果超过预期重置时间12秒还未重置，返回false
                if (Date.now() > nextReset + 12000) {
                    return false;
                }
                // 等待1.5秒后再次检查
                await new Promise((res)=>setTimeout(res, 1500));
            }
        }
    }

    prepareHash(currentHash, signerAddressBytes) {
        // 创建一个64字节的数组（32字节用于当前哈希，32字节用于签名者地址）
        const prepared = new Uint8Array(32 + 32); // nonce字节将为空
        // 设置当前哈希
        prepared.set(currentHash, 0);
        // 设置签名者地址
        prepared.set(signerAddressBytes, 32);

        return prepared;
    }

    createHash(currentHash, signerAddressBytes, nonce) {
        // 创建一个72字的数组（32字节用于当前哈希，32字节用于签名者地址，8字节用于nonce）
        const dataToHash = new Uint8Array(32 + 32 + 8);
        // 设置当前哈希
        dataToHash.set(currentHash, 0);
        // 设置签名者地址
        dataToHash.set(signerAddressBytes, 32);
        // 设置nonce
        dataToHash.set(u64toBytes(nonce), 64);

        return bigIntTo32Bytes(BigInt('0x'+hasher.keccak256(dataToHash)));
    }

    validateHash(hash, difficulty) {
        return hash.slice(0, difficulty).reduce((a, b) => a + b, 0) === 0;
    }

    async getLock() {
        try {
            const now = Date.now();
            const pid = process.pid;
            const lockContent = `${pid}:${now}`;

            // 尝试创建或更新锁文件
            await fs.writeFile(this.lockFilePath, lockContent, { flag: 'wx' });
            return true;
        } catch (error) {
            if (error.code === 'EEXIST') {
                // 锁文件已存在，检查是否过期
                const content = await fs.readFile(this.lockFilePath, 'utf8');
                const [lockedPid, lockTime] = content.split(':').map(Number);

                if (Date.now() - lockTime > this.lockTimeout) {
                    // 锁已过期，尝试获取新锁
                    try {
                        await this.releaseLock();
                        return await this.getLock();
                    } catch (e) {
                        return false;
                    }
                }

                // 检查持有锁的进程是否仍在运行
                try {
                    process.kill(lockedPid, 0);
                    return false; // 进程仍在运行，无法获取锁
                } catch (e) {
                    // 进程不存在，释放旧锁并重试
                    await this.releaseLock();
                    return await this.getLock();
                }
            }
            throw error;
        }
    }

    async releaseLock() {
        try {
            const content = await fs.readFile(this.lockFilePath, 'utf8');
            const [lockedPid] = content.split(':').map(Number);

            if (lockedPid === process.pid) {
                await fs.unlink(this.lockFilePath);
                return true;
            }
            return false;
        } catch (error) {
            if (error.code === 'ENOENT') {
                return false; // 锁文件不存在
            }
            throw error;
        }
    }

    async withLock(callback, retryInterval = 1000, maxRetries = Infinity) {
        let retries = 0;
        while (retries < maxRetries) {
            if (await this.getLock()) {
                try {
                    console.log('FOMO | 获取到锁，执行回调');
                    return await callback();
                } finally {
                    console.log('FOMO | 释放锁');
                    await this.releaseLock();
                }
            } else {
                console.log(`FOMO | 无法获取锁，等待 ${retryInterval}ms 后重试。尝试次数：${retries + 1}`);
                await new Promise(resolve => setTimeout(resolve, retryInterval));
                retries++;
            }
        }
        console.log('FOMO | 达到最大重试次数，无法获取锁');
        return null;
    }

}