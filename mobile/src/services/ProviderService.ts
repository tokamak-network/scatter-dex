/**
 * ProviderService — 읽기 전용 ethers JsonRpcProvider 싱글톤
 */
import { ethers } from 'ethers';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { ConfigService } from './ConfigService';

let readProvider: ethers.JsonRpcProvider | null = null;

export const ProviderService = {
  getReadProvider(): ethers.JsonRpcProvider {
    if (!readProvider) {
      readProvider = new ethers.JsonRpcProvider(ConfigService.getRpcUrl());
    }
    return readProvider;
  },

  async getEarliestBlock(): Promise<number> {
    const cached = await AsyncStorage.getItem('scatterdex_earliest_block');
    if (cached) return Number(cached);
    return ConfigService.getDeployBlock();
  },

  async cacheEarliestBlock(block: number): Promise<void> {
    await AsyncStorage.setItem('scatterdex_earliest_block', String(block));
  },

  reset() {
    readProvider = null;
  },
};
