import React from 'react';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import HomeScreen from '../screens/HomeScreen';
import DepositScreen from '../screens/DepositScreen';
import TradeScreen from '../screens/TradeScreen';
import ClaimScreen from '../screens/ClaimScreen';
import SettingsScreen from '../screens/SettingsScreen';

const Tab = createBottomTabNavigator();

export default function TabNavigator() {
  return (
    <Tab.Navigator
      screenOptions={{
        headerShown: false,
        tabBarStyle: {
          backgroundColor: '#111827',
          borderTopColor: '#1f2937',
        },
        tabBarActiveTintColor: '#95aaff',
        tabBarInactiveTintColor: '#6b7280',
      }}
    >
      <Tab.Screen name="Home" component={HomeScreen} />
      <Tab.Screen name="Deposit" component={DepositScreen} />
      <Tab.Screen name="Trade" component={TradeScreen} />
      <Tab.Screen name="Claim" component={ClaimScreen} />
      <Tab.Screen name="Settings" component={SettingsScreen} />
    </Tab.Navigator>
  );
}
