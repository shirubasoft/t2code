import { StackActions, useNavigation } from "@react-navigation/native";
import { useEffect } from "react";

export function ConnectOnboardingRouteScreen() {
  const navigation = useNavigation();
  useEffect(() => {
    if (navigation.canGoBack()) {
      navigation.goBack();
    } else {
      navigation.dispatch(StackActions.replace("Home"));
    }
  }, [navigation]);
  return null;
}
