import React from 'react';
import { Text } from 'react-native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import HomeScreen from '../screens/HomeScreen';
import TradeScreen from '../screens/TradeScreen';
import HistoryScreen from '../screens/HistoryScreen';
import SettingsScreen from '../screens/SettingsScreen';
import DepositScreen from '../screens/DepositScreen';
import ClaimScreen from '../screens/ClaimScreen';

const Tab = createBottomTabNavigator();

const icon = (emoji: string) => ({ focused }: { focused: boolean }) => (
  <Text style={{ fontSize: 22, opacity: focused ? 1 : 0.5 }}>{emoji}</Text>
);

export default function TabNavigator() {
  const insets = useSafeAreaInsets();
  return (
    <Tab.Navigator
      screenOptions={{
        headerShown: false,
        tabBarStyle: {
          backgroundColor: '#FFFFFF',
          borderTopColor: '#F3F4F6',
          borderTopWidth: 1,
          paddingTop: 6,
          // Honour the OS gesture / nav-bar inset so the bottom tabs
          // aren't hidden behind Android's home gesture pill or iOS's
          // home indicator. iOS's safe-area on the simulator was 0 so
          // the previous fixed `paddingBottom: 8` looked fine there;
          // Android gesture nav reports ~24 px which collides with
          // the tab bar.
          paddingBottom: 8 + insets.bottom,
          height: 60 + insets.bottom,
        },
        tabBarActiveTintColor: '#3B82F6',
        tabBarInactiveTintColor: '#9CA3AF',
        tabBarLabelStyle: { fontSize: 10, fontWeight: '500' },
      }}
    >
      <Tab.Screen name="Home" component={HomeScreen} options={{ tabBarIcon: icon('🏠') }} />
      <Tab.Screen name="Deposit" component={DepositScreen} options={{ tabBarIcon: icon('🔒'), tabBarLabel: 'Escrow' }} />
      <Tab.Screen name="Trade" component={TradeScreen} options={{ tabBarIcon: icon('⇄') }} />
      <Tab.Screen name="Claim" component={ClaimScreen} options={{ tabBarIcon: icon('💰'), tabBarLabel: 'Claim' }} />
      <Tab.Screen name="History" component={HistoryScreen} options={{ tabBarIcon: icon('📋'), tabBarLabel: 'Activity' }} />
      <Tab.Screen
        name="Settings"
        component={SettingsScreen}
        options={{
          tabBarItemStyle: { display: 'none' },
          tabBarButton: () => null,
        }}
      />
    </Tab.Navigator>
  );
}
